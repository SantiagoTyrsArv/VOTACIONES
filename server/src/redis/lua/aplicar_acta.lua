--[[
aplicar_acta.lua · RF-1, RF-2 y RF-3 (y la resolución de RF-7) en una sola
operación atómica.

Redis ejecuta el script completo sin intercalar comandos de otros clientes:
nadie puede leer el municipio actualizado y el puesto sin actualizar, y si
una instancia Node muere a mitad, el script ya terminó o nunca empezó.

Lua NO revierte escrituras si falla a mitad, por eso el script tiene dos
fases: (1) leer y validar TODO sin escribir; (2) escribir.

KEYS (todas declaradas, como exige Redis y como necesitaría un clúster):
  1  idem:{idem} | resolucion:{acta}:{token}   12 st:mun:{m}
  2  acta:{id}                                 13 st:dep
  3  cat:mesa:{n}                              14 seq:recibo
  4  tot:mesa:{n}                              15 verif:cola      (C)
  5  tot:pue:{p}                               16 st:verif        (C)
  6  tot:mun:{m}                               17 verif:casos     (C)
  7  tot:dep                                   18 verif:asignados (C)
  8  rank:pue:{p}                              19 lock:caso:{id}  (C)
  9  rank:mun:{m}                              20 fence:caso:{id} (C)
  10 rank:dep                                  21 pres:aud        (C)
  11 st:pue:{p}                                22 pres:info       (C)

ARGV:
  1  acta (JSON canónico, ya validado en formato)   7  MAXLEN de los streams
  2  casillas en orden canónico                     8  canal ch:actas
  3  candidatos (entran al ranking)                 9  canal ch:verif
  4  firma del contenido                            10 modo: jurado | verificacion | resolucion
  5  instancia que ingiere                          11 contexto de resolución (JSON) o ''
  6  TTL de idem en segundos                       12 '1' = exigir que la mesa esté asignada al jurado

Las actas dudosas y los conflictos se escriben como casos de C en
verif:casos (mismo formato que CaseRecord) y entran a verif:cola con la
prioridad de C: score = recibida − prioridad·10¹⁰ (menor = más urgente).
En modo resolucion se comprueban caso, versión, dueño, sesión, lock y
fencing token antes de cambiar votos: así un auditor tardío no pisa al
dueño vigente (no hay carrera entre comprobar y aplicar).

Respuesta: { estado, recibo_json_o_vacío, motivo_o_vacío }
]]

local acta = cjson.decode(ARGV[1])
local modo = ARGV[10]
local modo_verif = modo == 'verificacion'
local modo_resolucion = modo == 'resolucion'
local res = modo_resolucion and cjson.decode(ARGV[11]) or nil

local function split(s)
  local t = {}
  for x in string.gmatch(s, '[^,]+') do t[#t + 1] = x end
  return t
end
local CASILLAS = split(ARGV[2])
local CANDIDATOS = split(ARGV[3])
local CAMPOS = {}
for i, c in ipairs(CASILLAS) do CAMPOS[i] = c end
CAMPOS[#CAMPOS + 1] = 'sufragantes'

local function nuevo_caso(ms, motivo, prioridad)
  return {
    id = acta.acta,
    version = acta.version,
    mesa = tostring(acta.mesa),
    municipality = tostring(acta.municipio),
    reason = motivo,
    priority = prioridad,
    receivedAt = ms,
    votes = acta.votos,
    source = 'A',
    status = 'pending'
  }
end

-- Prioridad de C: menor score = se atiende antes.
local function puntaje(c)
  return c.receivedAt - c.priority * 10000000000
end

-- Deja el caso sin dueño (el token anterior queda obsoleto para siempre).
local function sin_asignacion(c)
  c.owner = nil
  c.ownerName = nil
  c.sessionId = nil
  c.token = nil
  c.assignedAt = nil
  c.lastActivity = nil
  c.leaseUntil = nil
  redis.call('ZREM', KEYS[18], acta.acta)
  redis.call('DEL', KEYS[19])
end

-- Encola esta versión como caso pendiente. Si ya había un caso abierto de la
-- misma versión se conserva (y su posible dueño); si era de otra versión o ya
-- estaba resuelto, se reemplaza por uno nuevo.
local function encolar(caso, ms, motivo, prioridad)
  if caso and caso.status ~= 'resolved' and caso.version == acta.version then
    return caso
  end
  if caso and caso.status == 'assigned' then sin_asignacion(caso) end
  local nuevo = nuevo_caso(ms, motivo, prioridad)
  redis.call('HSET', KEYS[17], acta.acta, cjson.encode(nuevo))
  redis.call('ZADD', KEYS[15], puntaje(nuevo), acta.acta)
  return nuevo
end

local function cerrar_caso(caso, resolucion, recibo)
  if caso.status == 'assigned' then sin_asignacion(caso) end
  caso.status = 'resolved'
  caso.resolution = resolucion
  caso.appliedReceipt = recibo
  redis.call('HSET', KEYS[17], acta.acta, cjson.encode(caso))
  redis.call('ZREM', KEYS[15], acta.acta)
  redis.call('ZREM', KEYS[18], acta.acta)
end

local function evento_verif(tipo, ms, extra)
  local e = extra or {}
  -- type/caseId: vocabulario de C; tipo/acta: vocabulario de A.
  e.type = tipo
  e.caseId = acta.acta
  e.tipo = tipo
  e.acta = acta.acta
  e.version = tostring(acta.version)
  e.ts = tostring(ms)
  e.instancia = ARGV[5]
  local campos = {}
  for k, v in pairs(e) do
    campos[#campos + 1] = k
    campos[#campos + 1] = tostring(v)
  end
  redis.call('XADD', KEYS[16], 'MAXLEN', '~', ARGV[7], '*', unpack(campos))
  redis.call('PUBLISH', ARGV[9], cjson.encode({ tipo = tipo, acta = acta.acta, motivo = e.motivo }))
end

-- FASE 1: idempotencia y todas las validaciones antes de escribir.
local previo = redis.call('GET', KEYS[1])
if previo then
  if modo_resolucion then
    local anterior = cjson.decode(previo)
    if anterior.huella ~= ARGV[11] then return { 'RECHAZADA', '', 'RESOLUCION_CONFLICTO' } end
    return { 'YA_REGISTRADA', anterior.recibo, '' }
  end
  local r = cjson.decode(previo)
  if r.acta ~= acta.acta or tonumber(r.version) ~= tonumber(acta.version) then
    return { 'RECHAZADA', '', 'IDEM_REUTILIZADO' }
  end
  return { 'YA_REGISTRADA', previo, '' }
end

-- El jurado (ya autenticado por su credencial) solo transmite sus mesas.
if ARGV[12] == '1' and redis.call('SISMEMBER', KEYS[23], tostring(acta.mesa)) == 0 then
  return { 'RECHAZADA', '', 'MESA_NO_ASIGNADA' }
end

local cat = redis.call('HMGET', KEYS[3], 'puesto', 'municipio')
if not cat[1] then return { 'RECHAZADA', '', 'MESA_DESCONOCIDA' } end
if tonumber(cat[1]) ~= acta.puesto or tonumber(cat[2]) ~= acta.municipio then
  return { 'RECHAZADA', '', 'UBICACION_INCONSISTENTE' }
end

local vig = redis.call('HMGET', KEYS[2], 'version', 'firma', 'recibo', 'mesa', 'votos_aplicados')
local v_old = tonumber(vig[1] or '0')
local recibo_vigente = vig[3] or ''
if vig[4] and tonumber(vig[4]) ~= acta.mesa then
  return { 'RECHAZADA', '', 'UBICACION_INCONSISTENTE' }
end

local caso_raw = redis.call('HGET', KEYS[17], acta.acta)
local caso = caso_raw and cjson.decode(caso_raw) or nil
if caso and (type(caso) ~= 'table' or caso.id ~= acta.acta or type(caso.version) ~= 'number') then
  return { 'RECHAZADA', '', 'INVALID_CASE' }
end

local tiempo = redis.call('TIME')
local ms = tonumber(tiempo[1]) * 1000 + math.floor(tonumber(tiempo[2]) / 1000)
local presencia = nil
if modo_resolucion then
  if not caso or caso.status ~= 'assigned' or caso.version ~= acta.version or v_old ~= acta.version then
    return { 'RECHAZADA', recibo_vigente, 'STALE_TOKEN' }
  end
  if caso.owner ~= res.actorId or caso.sessionId ~= res.sessionId or caso.token ~= res.token
    or redis.call('GET', KEYS[19]) ~= res.actorId .. ':' .. res.token
    or redis.call('GET', KEYS[20]) ~= res.token then
    return { 'RECHAZADA', recibo_vigente, 'STALE_TOKEN' }
  end
  local p_raw = redis.call('HGET', KEYS[22], res.actorId)
  presencia = p_raw and cjson.decode(p_raw) or nil
  local latido = tonumber(redis.call('ZSCORE', KEYS[21], res.actorId) or '0')
  if not presencia or presencia.sessionId ~= res.sessionId or ms - latido > 30000 then
    return { 'RECHAZADA', recibo_vigente, 'STALE_TOKEN' }
  end
  if type(caso.lastActivity) ~= 'number' or ms - caso.lastActivity >= 600000 then
    return { 'RECHAZADA', recibo_vigente, 'STALE_TOKEN' }
  end
elseif acta.version < v_old then
  return { 'VERSION_OBSOLETA', recibo_vigente, '' }
elseif acta.version == v_old then
  if vig[2] == ARGV[4] then
    redis.call('SET', KEYS[1], recibo_vigente, 'EX', ARGV[6])
    return { 'YA_REGISTRADA', recibo_vigente, '' }
  end
  redis.call('HSET', KEYS[2], 'conflicto', '1')
  -- Si un auditor ya resolvió esta versión, el conflicto no reabre el caso.
  if caso and caso.status == 'resolved' and caso.version == acta.version then
    return { 'RECHAZADA', recibo_vigente, 'CONFLICTO_VERSION' }
  end
  encolar(caso, ms, 'Conflicto de versión: misma versión con otros votos', 100)
  evento_verif('encolada', ms, { motivo = 'conflicto_version' })
  return { 'RECHAZADA', recibo_vigente, 'CONFLICTO_VERSION' }
end

local suma = 0
for _, c in ipairs(CASILLAS) do suma = suma + acta.votos[c] end
local cuadra = suma == acta.sufragantes
local rechazada_por_auditor = modo_resolucion and res.resolution.action == 'reject'
local valida = not rechazada_por_auditor and (cuadra or modo_verif or modo_resolucion)

local aplicados = nil
if vig[5] and vig[5] ~= '' then aplicados = cjson.decode(vig[5]) end
local nuevos = nil
if valida then
  nuevos = {}
  for _, c in ipairs(CASILLAS) do nuevos[c] = acta.votos[c] end
  nuevos.sufragantes = acta.sufragantes
end

local delta = {}
local hay_cambio = false
for _, c in ipairs(CAMPOS) do
  local d = (nuevos and nuevos[c] or 0) - (aplicados and aplicados[c] or 0)
  delta[c] = d
  if d ~= 0 then hay_cambio = true end
end
local mesas_delta = (nuevos and 1 or 0) - (aplicados and 1 or 0)
if mesas_delta ~= 0 then hay_cambio = true end

local motivo
if modo_resolucion or modo_verif then motivo = 'verificacion'
elseif aplicados == nil then motivo = 'nueva'
elseif nuevos == nil then motivo = 'retiro_dudosa'
else motivo = 'correccion' end

-- FASE 2: recibo, acta y acumulados.
local seq = redis.call('INCR', KEYS[14])
local estado = valida and 'REGISTRADA' or (modo_resolucion and 'RECHAZADA' or 'DUDOSA_EN_VERIFICACION')
local recibo = cjson.encode({
  recibo = string.format('R-%06d', seq),
  acta = acta.acta,
  version = acta.version,
  estado = estado,
  idem = acta.idem,
  ts = ms,
  instancia = ARGV[5],
})

redis.call('HSET', KEYS[2],
  'version', tostring(acta.version),
  'firma', ARGV[4],
  'estado', estado,
  'mesa', tostring(acta.mesa),
  'puesto', tostring(acta.puesto),
  'municipio', tostring(acta.municipio),
  'jurado', acta.jurado,
  'votos', cjson.encode(acta.votos),
  'sufragantes', tostring(acta.sufragantes),
  'hash_foto', acta.hash_foto or '',
  'ts_cierre', tostring(acta.ts_cierre or 0),
  'votos_aplicados', nuevos and cjson.encode(nuevos) or '',
  'recibo', recibo,
  'actualizada', tostring(ms))

local ids = {}
if hay_cambio then
  for k = 4, 7 do
    for _, c in ipairs(CAMPOS) do
      if delta[c] ~= 0 then redis.call('HINCRBY', KEYS[k], c, delta[c]) end
    end
    if mesas_delta ~= 0 then redis.call('HINCRBY', KEYS[k], 'mesas_inf', mesas_delta) end
  end
  for k = 8, 10 do
    for _, c in ipairs(CANDIDATOS) do
      if delta[c] ~= 0 then redis.call('ZINCRBY', KEYS[k], delta[c], c) end
    end
  end

  local delta_min = {}
  for _, c in ipairs(CAMPOS) do
    if delta[c] ~= 0 then delta_min[c] = delta[c] end
  end
  if mesas_delta ~= 0 then delta_min.mesas_inf = mesas_delta end
  local delta_json = cjson.encode(delta_min)
  local topicos = { 'pue:' .. acta.puesto, 'mun:' .. acta.municipio, 'dep' }
  for i = 1, 3 do
    local plano = redis.call('HGETALL', KEYS[4 + i])
    local totales = {}
    for j = 1, #plano, 2 do totales[plano[j]] = tonumber(plano[j + 1]) end
    ids[topicos[i]] = redis.call('XADD', KEYS[10 + i], 'MAXLEN', '~', ARGV[7], '*',
      'tipo', 'acta', 'acta', acta.acta, 'mesa', tostring(acta.mesa),
      'version', tostring(acta.version), 'version_anterior', tostring(v_old),
      'motivo', motivo, 'delta', delta_json, 'totales', cjson.encode(totales),
      'ts', tostring(ms), 'recibida_ms', tostring(ms), 'instancia', ARGV[5])
  end
  redis.call('PUBLISH', ARGV[8], cjson.encode({
    acta = acta.acta, version = acta.version, motivo = motivo, ids = ids, ts = ms,
    topics = topicos, streamIds = ids,
  }))
end

if modo_resolucion then
  cerrar_caso(caso, res.resolution, recibo)
  if presencia and presencia.sessionId == res.sessionId then
    presencia.caseId = nil
    redis.call('HSET', KEYS[22], res.actorId, cjson.encode(presencia))
  end
  redis.call('SET', KEYS[1], cjson.encode({ huella = ARGV[11], recibo = recibo }))
  evento_verif('resuelta', ms, { motivo = res.resolution.action, auditor = res.actorId, recibo = recibo })
  return { estado, recibo, '' }
end

if not valida then
  local desfase = math.abs(suma - acta.sufragantes)
  -- Cada voto de descuadre sube la prioridad (90 + desfase, tope 99; 100 = conflicto).
  encolar(caso, ms, string.format('Descuadre contable: %d votos de diferencia', desfase),
    math.min(99, 90 + desfase))
  evento_verif('encolada', ms, { motivo = 'descuadre', desfase = tostring(desfase) })
elseif caso and caso.status ~= 'resolved' then
  -- Una versión válida del jurado supera al caso abierto.
  cerrar_caso(caso, { action = 'approve', note = 'Superada por una versión válida del jurado' }, recibo)
  evento_verif('retirada', ms, { motivo = modo_verif and 'verificada' or 'superada' })
end

redis.call('SET', KEYS[1], recibo, 'EX', ARGV[6])
return { estado, recibo, '' }
