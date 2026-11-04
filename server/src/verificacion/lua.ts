// Redis no revierte escrituras si Lua falla. Comprobamos tipos y entradas antes de escribir.
const common = `
local expected = {'hash','zset','zset','string','string','stream','none','zset','hash'}
for i=1,9 do
  if i ~= 7 then
    local t = redis.call('TYPE', KEYS[i]).ok
    if t ~= 'none' and t ~= expected[i] then return redis.error_reply('WRONGTYPE preflight '..KEYS[i]) end
  end
end
local tm = redis.call('TIME')
local now = tonumber(tm[1])*1000 + math.floor(tonumber(tm[2])/1000)
local id, owner, sid, token = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local raw = redis.call('HGET', KEYS[1], id)
local c = raw and cjson.decode(raw) or nil
if c then
  if type(c) ~= 'table' or c.id ~= id or type(c.version) ~= 'number' or type(c.priority) ~= 'number'
    or type(c.receivedAt) ~= 'number' or type(c.votes) ~= 'table' or type(c.mesa) ~= 'string'
    or type(c.municipality) ~= 'string' or type(c.reason) ~= 'string'
    or (c.status ~= 'pending' and c.status ~= 'assigned' and c.status ~= 'resolved') then
    return redis.error_reply('INVALID_CASE_RECORD')
  end
  if c.status == 'assigned' and (type(c.owner) ~= 'string' or type(c.token) ~= 'string'
    or type(c.sessionId) ~= 'string' or type(c.lastActivity) ~= 'number' or type(c.leaseUntil) ~= 'number') then
    return redis.error_reply('INVALID_ASSIGNMENT_RECORD')
  end
end
local pRaw = redis.call('HGET', KEYS[9], owner)
local p = pRaw and cjson.decode(pRaw) or nil
if p and (type(p) ~= 'table' or type(p.sessionId) ~= 'string' or type(p.name) ~= 'string'
  or (p.role ~= 'auditor' and p.role ~= 'coordinator')) then return redis.error_reply('INVALID_PRESENCE_RECORD') end
local function result(code, extra)
  local r = extra or {}; r.code = code; return cjson.encode(r)
end
local function currentSession()
  local seen = tonumber(redis.call('ZSCORE', KEYS[8], owner) or '0')
  return p and p.sessionId == sid and now-seen <= 30000
end
local function held()
  return c and c.status == 'assigned' and c.owner == owner and c.token == token
    and c.sessionId == sid and redis.call('GET', KEYS[4]) == owner..':'..token
    and redis.call('GET', KEYS[5]) == token and currentSession()
end
local function save() redis.call('HSET', KEYS[1], id, cjson.encode(c)) end
local function presenceCase(value)
  if p and p.sessionId == sid then p.caseId = value; redis.call('HSET', KEYS[9], owner, cjson.encode(p)) end
end
local function event(kind)
  local eid = redis.call('XADD', KEYS[6], 'MAXLEN', '~', '10000', '*', 'type', kind, 'caseId', id, 'owner', owner, 'token', token or '')
  redis.call('PUBLISH', KEYS[7], cjson.encode({type=kind,caseId=id,eventId=eid}))
end
local function clearAssignment()
  c.status='pending'; c.owner=nil; c.ownerName=nil; c.sessionId=nil; c.token=nil
  c.assignedAt=nil; c.lastActivity=nil; c.leaseUntil=nil
end
`;

export const caseScripts = {
  enqueue:
    common +
    `
    local input = cjson.decode(ARGV[5])
    if c then
      local same = c.version == input.version and c.reason == input.reason and c.mesa == input.mesa
        and c.municipality == input.municipality and c.source == input.source and c.priority == input.priority and c.receivedAt == input.receivedAt
      for candidate,value in pairs(input.votes) do if c.votes[candidate] ~= value then same=false end end
      for candidate,value in pairs(c.votes) do if input.votes[candidate] ~= value then same=false end end
      if same then return result('EXISTS') end
      return result('CASE_CONFLICT')
    end
    c=input; c.status='pending'; save()
    redis.call('ZADD', KEYS[2], c.receivedAt-c.priority*10000000000, id)
    event('queued'); return result('QUEUED')
  `,
  take:
    common +
    `
    if not c then return result('NOT_FOUND') end
    if not currentSession() then return result('SESSION_REPLACED') end
    if p.role ~= 'auditor' then return result('FORBIDDEN') end
    if p.caseId and p.caseId ~= cjson.null then
      local otherRaw = redis.call('HGET', KEYS[1], p.caseId)
      local other = otherRaw and cjson.decode(otherRaw) or nil
      if other and other.status == 'assigned' then return result('ALREADY_WORKING') end
    end
    if c.status ~= 'pending' or redis.call('EXISTS', KEYS[4]) == 1 or not redis.call('ZSCORE', KEYS[2], id) then return result('BUSY') end
    local f = redis.call('GET', KEYS[5])
    if f and (not string.match(f, '^%d+$') or tonumber(f) >= 9007199254740000) then return redis.error_reply('INVALID_FENCE') end
    redis.call('INCR', KEYS[5]); token=redis.call('GET', KEYS[5])
    redis.call('SET', KEYS[4], owner..':'..token, 'NX', 'PX', 30000)
    c.status='assigned'; c.owner=owner; c.ownerName=p.name; c.sessionId=sid; c.token=token
    c.assignedAt=now; c.lastActivity=now; c.leaseUntil=now+30000
    redis.call('ZREM', KEYS[2], id); redis.call('ZADD', KEYS[3], c.leaseUntil, id)
    save(); presenceCase(id); event('taken'); return result('TAKEN', {token=token,caseId=id})
  `,
  renew:
    common +
    `
    if not held() then return result('STALE_TOKEN') end
    if ARGV[5] == '1' then c.lastActivity=now end
    if now-c.lastActivity >= 600000 then return result('INACTIVE') end
    c.leaseUntil=now+30000
    redis.call('PEXPIRE', KEYS[4], 30000); redis.call('ZADD', KEYS[3], c.leaseUntil, id); save()
    return result('RENEWED')
  `,
  resume:
    common +
    `
    if not c or c.status ~= 'assigned' or c.owner ~= owner or c.token ~= token
      or redis.call('GET', KEYS[4]) ~= owner..':'..token or redis.call('GET', KEYS[5]) ~= token
      or not currentSession() then return result('STALE_TOKEN') end
    if now-c.lastActivity >= 600000 then return result('INACTIVE') end
    c.sessionId=sid; save(); presenceCase(id); event('resumed')
    return result('RESUMED', {token=token,caseId=id})
  `,
  release:
    common +
    `
    if not held() then return result('STALE_TOKEN') end
    redis.call('DEL', KEYS[4]); redis.call('ZREM', KEYS[3], id)
    clearAssignment(); save(); presenceCase(nil)
    redis.call('ZADD', KEYS[2], c.receivedAt-c.priority*10000000000, id)
    event('released'); return result('RELEASED')
  `,
  check:
    common +
    `
    if not held() then return result('STALE_TOKEN') end
    if now-c.lastActivity >= 600000 then return result('INACTIVE') end
    return result('VALID')
  `,
  sweep:
    common +
    `
    if not c or c.status ~= 'assigned' then redis.call('ZREM', KEYS[3], id); return result('UNCHANGED') end
    if redis.call('EXISTS', KEYS[4]) == 1 then return result('LOCKED') end
    owner=c.owner; sid=c.sessionId; token=c.token
    local oldRaw=redis.call('HGET', KEYS[9], owner); p=oldRaw and cjson.decode(oldRaw) or nil
    redis.call('ZREM', KEYS[3], id); clearAssignment(); save(); presenceCase(nil)
    redis.call('ZADD', KEYS[2], c.receivedAt-c.priority*10000000000, id)
    event('recovered'); return result('RECOVERED')
  `,
};

export const presenceScript = `
local expected = {'zset','hash'}
for i=1,2 do local t=redis.call('TYPE',KEYS[i]).ok; if t~='none' and t~=expected[i] then return redis.error_reply('WRONGTYPE presence') end end
local tm=redis.call('TIME'); local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local op,id,sid=ARGV[1],ARGV[2],ARGV[3]
local raw=redis.call('HGET',KEYS[2],id); local old=raw and cjson.decode(raw) or nil
if op=='connect' then
  local p=cjson.decode(ARGV[4]); p.since=now; p.lastSeen=now
  redis.call('HSET',KEYS[2],id,cjson.encode(p)); redis.call('ZADD',KEYS[1],now,id)
  redis.call('PUBLISH',KEYS[3],'{"type":"presence"}'); return 'CONNECTED'
end
if op=='beat' then
  if not old or old.sessionId~=sid then return 'SESSION_REPLACED' end
  old.lastSeen=now; redis.call('HSET',KEYS[2],id,cjson.encode(old)); redis.call('ZADD',KEYS[1],now,id); return 'PRESENT'
end
if op=='leave' then
  if not old or old.sessionId~=sid then return 'UNCHANGED' end
  redis.call('HDEL',KEYS[2],id); redis.call('ZREM',KEYS[1],id)
  redis.call('PUBLISH',KEYS[3],'{"type":"presence"}'); return 'LEFT'
end
if op=='sweep' then
  local stale=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf','('..tostring(now-30000),'LIMIT',0,500)
  for _,ghost in ipairs(stale) do redis.call('ZREM',KEYS[1],ghost); redis.call('HDEL',KEYS[2],ghost) end
  if #stale>0 then redis.call('PUBLISH',KEYS[3],'fn:presence') end
  return tostring(#stale)
end
return redis.error_reply('UNKNOWN_OPERATION')
`;
