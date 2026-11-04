# Contrato compartido (v0.1, propuesta)

> **Estado:** propuesta de la Persona A, pendiente de aprobación por A, B y C (compuerta "contrato acordado" de la semana 1). Fuente de verdad: los tipos de [`shared/src`](../shared/src). Si este documento y el código no coinciden, manda el código.

## 1. Acta (jurado → servidor)

Definida en [`shared/src/acta.ts`](../shared/src/acta.ts), igual al enunciado (§3.1):

```json
{
  "acta": "E14-176-0042-03",
  "mesa": 4201, "puesto": 176, "municipio": 11,
  "version": 1,
  "jurado": "JUR-88134",
  "ts_cierre": 1793577600,
  "votos": { "C1": 184, "C2": 97, "C3": 311, "BLANCO": 22, "NULO": 9, "NO_MARCADO": 4 },
  "sufragantes": 627,
  "hash_foto": "9f2c...",
  "idem": "8f14e45fceea167a"
}
```

| Regla | Dónde se valida | Si falla |
|---|---|---|
| Formato (tipos, rangos, casillas exactas, puesto del id = `puesto`) | `validarActa()` en PWA y servidor | `RECHAZADA` / `FORMATO` |
| La mesa existe en el catálogo y su puesto y municipio coinciden | `aplicar_acta.lua` | `RECHAZADA` / `MESA_DESCONOCIDA` o `UBICACION_INCONSISTENTE` |
| Regla contable: Σ casillas = `sufragantes` | `aplicar_acta.lua` | `DUDOSA_EN_VERIFICACION` (se registra, no suma) |

Candidatos: `C1`, `C2`, `C3`. Casillas especiales: `BLANCO`, `NULO`, `NO_MARCADO`.

## 2. Respuestas al jurado

Definidas en [`shared/src/recibo.ts`](../shared/src/recibo.ts).

| Estado | ¿Quedó registrada? | ¿Reintentar? | HTTP (`POST /actas`) |
|---|---|---|---|
| `REGISTRADA` | Sí, suma | No | 201 |
| `YA_REGISTRADA` | Sí (antes); trae el recibo **original** | No | 200 |
| `DUDOSA_EN_VERIFICACION` | Sí, no suma | No | 202 |
| `VERSION_OBSOLETA` | Ya hay una versión ≥; trae el recibo vigente | No | 409 |
| `RECHAZADA` | No; hay que corregir el acta | No | 422 |
| `NO_REGISTRADA` | **No**; Redis no disponible | Sí, sola | 503 + `Retry-After` |
| `LIMITE_EXCEDIDO` | **No** | Sí, tras `reintentar_en_ms` | 429 + `Retry-After` |

## 3. WebSocket de jurados

Ruta `/ws/jurados`. Mensajes JSON, uno por trama.

```
servidor → { "tipo": "bienvenida", "instancia": "r-3", "protocolo": 1 }
cliente  → { "tipo": "acta", "acta": { …Acta… } }
servidor → { "tipo": "respuesta", "idem": "8f14…", "respuesta": { "estado": "REGISTRADA", "recibo": {…}, "instancia": "r-3" } }
servidor → { "tipo": "error", "codigo": "MENSAJE_INVALIDO", "detalle": "…" }
```

## 4. Claves de Redis

Definidas en [`shared/src/claves.ts`](../shared/src/claves.ts). Tópicos: `dep`, `mun:{m}`, `pue:{p}`.

| Clave | Tipo | Escribe | Lee | Contenido |
|---|---|---|---|---|
| `tot:mesa:{n}` | Hash | A | — | casillas, `sufragantes`, `mesas_inf` (0/1) |
| `tot:{topico}` | Hash | A | B | casillas, `sufragantes`, `mesas_inf`, `mesas_tot` |
| `rank:{topico}` | ZSET | A | B | miembro = candidato, score = votos |
| `st:{topico}` | Stream | A | B | ver §5 |
| `acta:{id}` | Hash | A | C | `version`, `estado`, `firma`, `votos`, `votos_aplicados`, `recibo`, `conflicto` |
| `idem:{idem}` | String | A | A | recibo JSON, `EX 86400` |
| `cat:mesa:{n}` | Hash | A (generador) | A | `puesto`, `municipio` |
| `seq:recibo` | String | A | — | consecutivo de recibos |
| `rl:{credencial}:{ventana}` | String | A | — | contador, `EX 60` |
| `verif:cola` | ZSET | A encola, C toma | C | miembro = id del acta, score = prioridad |
| `st:verif` | Stream | A y C | C | eventos de la cola |
| `lock:caso:{acta}`, `fence:caso:{acta}`, `pres:aud`, `pres:info` | — | C | C | bloqueo y presencia |

## 5. Entradas de `st:{topico}`

Escritas por `aplicar_acta.lua` en los tres tópicos del acta (`pue`, `mun`, `dep`) dentro de la misma operación atómica. Todos los campos son texto:

| Campo | Ejemplo | Significado |
|---|---|---|
| `tipo` | `acta` | |
| `acta`, `mesa` | `E14-176-0042-03`, `4201` | |
| `version`, `version_anterior` | `2`, `1` | `0` si es nueva |
| `motivo` | `nueva` · `correccion` · `retiro_dudosa` · `verificacion` | Explica cualquier retroceso al público |
| `delta` | `{"C1":-3,"C2":3}` | Cambio que produjo en este nivel |
| `totales` | `{"C1":5120,…,"mesas_inf":31,"mesas_tot":40}` | Totales del nivel **después** de aplicar |
| `ts` | `1793577612345` | Hora de Redis en ms |
| `recibida_ms` | `1793577612234` | Recepción del acta en ms; B calcula la latencia acta → pantalla |
| `instancia` | `r-3` | Quién ingirió el acta |

## 6. Pub/Sub

| Canal | Publica | Mensaje |
|---|---|---|
| `ch:actas` | `aplicar_acta.lua` | `AvisoActa`: `{ acta, version, motivo, ids, topics, streamIds, ts }`; `ids` y `streamIds` contienen `{ "pue:176": "…", "mun:11": "…", "dep": "…" }` |
| `ch:verif` | A (al encolar) y C | evento de la cola de verificación |

`ch:actas` es solo un timbre: si se pierde un aviso, la información sigue en los streams.

## 7. Lectura atómica

`leer_topico.lua` devuelve una `Fotografia` (`totales`, `ranking`, `ultimo_id`) en un solo paso, de modo que el snapshot y su id de stream siempre coinciden. B lo usa para `event: snapshot` y para el polling.
