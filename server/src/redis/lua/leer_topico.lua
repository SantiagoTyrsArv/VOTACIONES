--[[
leer_topico.lua · fotografía atómica de un tópico.

Devuelve totales, ranking y último id del stream en un solo paso, para que
el snapshot y su id siempre coincidan: un cliente que recibe la fotografía y
luego pide `XRANGE (ultimo_id +` no pierde ni duplica ninguna acta.

KEYS: 1 tot:{topico}  2 rank:{topico}  3 st:{topico}
Respuesta: { hgetall_plano, zrevrange_withscores_plano, ultimo_id }
]]
local totales = redis.call('HGETALL', KEYS[1])
local ranking = redis.call('ZREVRANGE', KEYS[2], 0, -1, 'WITHSCORES')
local ultimo = redis.call('XREVRANGE', KEYS[3], '+', '-', 'COUNT', 1)
local id = '0-0'
if ultimo[1] then id = ultimo[1][1] end
return { totales, ranking, id }
