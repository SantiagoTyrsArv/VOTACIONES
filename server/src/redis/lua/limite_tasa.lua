--[[
limite_tasa.lua · contador por credencial en ventana fija.

INCR y EXPIRE van juntos en el script: si la instancia muere entre los dos,
no queda un contador sin expiración que bloquee para siempre al jurado.

KEYS: 1 rl:{credencial}:{ventana}
ARGV: 1 límite   2 duración de la ventana en segundos
Respuesta: { permitido (1/0), conteo, ms_para_reiniciar }
]]
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
local pttl = redis.call('PTTL', KEYS[1])
if n > tonumber(ARGV[1]) then return { 0, n, pttl } end
return { 1, n, pttl }
