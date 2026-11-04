--[[
aplicar_acta.lua · RF-1, RF-2 y RF-3 en una sola operación atómica.

Redis ejecuta el script completo sin intercalar comandos de otros clientes:
nadie puede leer el municipio actualizado y el puesto sin actualizar, y si
una instancia Node muere a mitad, el script ya terminó o nunca empezó.

Lua NO revierte escrituras si falla a mitad, por eso el script tiene dos
fases: (1) leer y validar TODO sin escribir; (2) escribir. Ningún camino de
la fase 2 puede fallar por datos del acta.

KEYS (todas declaradas, como exige Redis y como necesitaría un clúster):
  1  idem:{idem}         7  tot:dep            13 st:dep
  2  acta:{id}           8  rank:pue:{p}       14 seq:recibo
  3  cat:mesa:{n}        9  rank:mun:{m}       15 verif:cola
  4  tot:mesa:{n}        10 rank:dep           16 st:verif
  5  tot:pue:{p}         11 st:pue:{p}
  6  tot:mun:{m}         12 st:mun:{m}

ARGV:
  1  acta (JSON canónico, ya validado en formato por validarActa)
  2  casillas, separadas por coma, en orden canónico
  3  candidatos, separados por coma (los que entran al ranking)
  4  firma del contenido (firmaContenido)
  5  instancia que ingiere
  6  TTL de idem en segundos
  7  MAXLEN aproximado de los streams
  8  canal de avisos de actas (ch:actas)
  9  canal de verificación (ch:verif)
  10 modo: 'jurado' | 'verificacion' (solo verificación acepta un descuadre)

Respuesta: { estado, recibo_json_o_vacío, motivo_o_vacío }
]]

local acta = cjson.decode(ARGV[1])
local modo_verif = ARGV[10] == 'verificacion'

local function split(s)
  local t = {}
  for x in string.gmatch(s, '[^,]+') do t[#t + 1] = x end
  return t
end
local CASILLAS = split(ARGV[2])
local CANDIDATOS = split(ARGV[3])
local CAMPOS = {}                       -- casillas + sufragantes
for i, c in ipairs(CASILLAS) do CAMPOS[i] = c end
CAMPOS[#CAMPOS + 1] = 'sufragantes'

-- ═════════════════════ FASE 1: leer y validar, sin escribir ═════════════════

-- 1.a Vía rápida de idempotencia: este mismo envío ya se procesó.
local previo = redis.call('GET', KEYS[1])
if previo then
  local r = cjson.decode(previo)
  if r.acta ~= acta.acta or tonumber(r.version) ~= tonumber(acta.version) then
    return { 'RECHAZADA', '', 'IDEM_REUTILIZADO' }
  end
  return { 'YA_REGISTRADA', previo, '' }
end

-- 1.b La mesa existe y el acta dice el puesto y municipio correctos.
local cat = redis.call('HMGET', KEYS[3], 'puesto', 'municipio')
if not cat[1] then return { 'RECHAZADA', '', 'MESA_DESCONOCIDA' } end
if tonumber(cat[1]) ~= acta.puesto or tonumber(cat[2]) ~= acta.municipio then
  return { 'RECHAZADA', '', 'UBICACION_INCONSISTENTE' }
end

-- 1.c Estado vigente del acta.
local vig = redis.call('HMGET', KEYS[2], 'version', 'firma', 'recibo', 'mesa', 'votos_aplicados')
local v_old = tonumber(vig[1] or '0')
local recibo_vigente = vig[3] or ''
if vig[4] and tonumber(vig[4]) ~= acta.mesa then
  return { 'RECHAZADA', '', 'UBICACION_INCONSISTENTE' }
end

-- 1.d Regla de versiones (RF-2): gana la más alta.
if acta.version < v_old then
  return { 'VERSION_OBSOLETA', recibo_vigente, '' }
end
if acta.version == v_old then
  if vig[2] == ARGV[4] then
    -- Mismo contenido con otro idem (p. ej. el idem expiró): ya estaba registrada.
    redis.call('SET', KEYS[1], recibo_vigente, 'EX', ARGV[6])
    return { 'YA_REGISTRADA', recibo_vigente, '' }
  end
  -- Misma versión, distinto contenido: conflicto. No se toca el acumulado,
  -- se marca y se manda a verificación con prioridad máxima.
  local t = redis.call('TIME')
  local ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  redis.call('HSET', KEYS[2], 'conflicto', '1')
  redis.call('ZADD', KEYS[15], ms - 3600000, acta.acta)
  redis.call('XADD', KEYS[16], 'MAXLEN', '~', ARGV[7], '*',
    'tipo', 'encolada', 'acta', acta.acta, 'version', tostring(acta.version),
    'motivo', 'conflicto_version', 'ts', tostring(ms), 'instancia', ARGV[5])
  redis.call('PUBLISH', ARGV[9], cjson.encode({ tipo = 'encolada', acta = acta.acta, motivo = 'conflicto_version' }))
  return { 'RECHAZADA', recibo_vigente, 'CONFLICTO_VERSION' }
end

-- 1.e Regla contable: suma de casillas = sufragantes.
local suma = 0
for _, c in ipairs(CASILLAS) do suma = suma + acta.votos[c] end
local cuadra = suma == acta.sufragantes
local valida = cuadra or modo_verif

-- 1.f Delta = lo que debe sumar ahora − lo que ya sumaba esta mesa.
--     Si la versión más alta no cuadra, la mesa deja de sumar (retiro) hasta
--     que verificación la resuelva: así el estado final depende solo del
--     conjunto de versiones recibidas, no del orden de llegada.
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
if modo_verif then motivo = 'verificacion'
elseif aplicados == nil then motivo = 'nueva'
elseif nuevos == nil then motivo = 'retiro_dudosa'
else motivo = 'correccion' end

-- ═════════════════════ FASE 2: escribir ═════════════════════════════════════

local t = redis.call('TIME')
local ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local seq = redis.call('INCR', KEYS[14])
local estado = valida and 'REGISTRADA' or 'DUDOSA_EN_VERIFICACION'
local recibo = cjson.encode({
  recibo = string.format('R-%06d', seq),
  acta = acta.acta,
  version = acta.version,
  estado = estado,
  idem = acta.idem,
  ts = ms,
  instancia = ARGV[5],
})

local votos_json = cjson.encode(acta.votos)
redis.call('HSET', KEYS[2],
  'version', tostring(acta.version),
  'firma', ARGV[4],
  'estado', estado,
  'mesa', tostring(acta.mesa),
  'puesto', tostring(acta.puesto),
  'municipio', tostring(acta.municipio),
  'jurado', acta.jurado,
  'votos', votos_json,
  'sufragantes', tostring(acta.sufragantes),
  'votos_aplicados', nuevos and cjson.encode(nuevos) or '',
  'recibo', recibo,
  'actualizada', tostring(ms))

local ids = {}
if hay_cambio then
  -- Mesa + 3 niveles con el mismo delta.
  for k = 4, 7 do
    for _, c in ipairs(CAMPOS) do
      if delta[c] ~= 0 then redis.call('HINCRBY', KEYS[k], c, delta[c]) end
    end
    if mesas_delta ~= 0 then redis.call('HINCRBY', KEYS[k], 'mesas_inf', mesas_delta) end
  end
  -- Rankings: O(log N) por candidato; la lectura es ZREVRANGE 0 k.
  for k = 8, 10 do
    for _, c in ipairs(CANDIDATOS) do
      if delta[c] ~= 0 then redis.call('ZINCRBY', KEYS[k], delta[c], c) end
    end
  end

  -- Delta compacto (solo lo que cambió) para streams y aviso.
  local delta_min = {}
  for _, c in ipairs(CAMPOS) do
    if delta[c] ~= 0 then delta_min[c] = delta[c] end
  end
  if mesas_delta ~= 0 then delta_min.mesas_inf = mesas_delta end
  local delta_json = cjson.encode(delta_min)

  -- Un stream por tópico con los totales DESPUÉS de aplicar: quien
  -- reconecta puede ponerse al día sin pedir una fotografía.
  local topicos = { 'pue:' .. acta.puesto, 'mun:' .. acta.municipio, 'dep' }
  for i = 1, 3 do
    local plano = redis.call('HGETALL', KEYS[4 + i])
    local totales = {}
    for j = 1, #plano, 2 do totales[plano[j]] = tonumber(plano[j + 1]) end
    ids[topicos[i]] = redis.call('XADD', KEYS[10 + i], 'MAXLEN', '~', ARGV[7], '*',
      'tipo', 'acta',
      'acta', acta.acta,
      'mesa', tostring(acta.mesa),
      'version', tostring(acta.version),
      'version_anterior', tostring(v_old),
      'motivo', motivo,
      'delta', delta_json,
      'totales', cjson.encode(totales),
      'ts', tostring(ms),
      'instancia', ARGV[5])
  end

  redis.call('PUBLISH', ARGV[8], cjson.encode({
    acta = acta.acta, version = acta.version, motivo = motivo, ids = ids, ts = ms,
  }))
end

-- Cola de verificación (C la consume): encolar dudosas, retirar superadas.
if not valida then
  local desfase = math.abs(suma - acta.sufragantes)
  -- Menor score = más urgente: cada voto de descuadre adelanta 1 minuto.
  redis.call('ZADD', KEYS[15], ms - desfase * 60000, acta.acta)
  redis.call('XADD', KEYS[16], 'MAXLEN', '~', ARGV[7], '*',
    'tipo', 'encolada', 'acta', acta.acta, 'version', tostring(acta.version),
    'motivo', 'descuadre', 'desfase', tostring(desfase),
    'ts', tostring(ms), 'instancia', ARGV[5])
  redis.call('PUBLISH', ARGV[9], cjson.encode({ tipo = 'encolada', acta = acta.acta, motivo = 'descuadre' }))
elseif redis.call('ZREM', KEYS[15], acta.acta) == 1 then
  redis.call('XADD', KEYS[16], 'MAXLEN', '~', ARGV[7], '*',
    'tipo', 'retirada', 'acta', acta.acta, 'version', tostring(acta.version),
    'motivo', modo_verif and 'verificada' or 'superada',
    'ts', tostring(ms), 'instancia', ARGV[5])
  redis.call('PUBLISH', ARGV[9], cjson.encode({ tipo = 'retirada', acta = acta.acta }))
end

-- El recibo se guarda en el mismo paso atómico que el registro.
redis.call('SET', KEYS[1], recibo, 'EX', ARGV[6])
return { estado, recibo, '' }
