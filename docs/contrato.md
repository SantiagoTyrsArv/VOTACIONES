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
| Credencial válida y del mismo jurado que `acta.jurado` (si `JURADO_SECRETO` está definido) | transporte + `ServicioIngesta` | HTTP 401 / `RECHAZADA` · `NO_AUTORIZADO` |
| La mesa está asignada al jurado (`jur:{jurado}:mesas`) | `aplicar_acta.lua` | `RECHAZADA` / `MESA_NO_ASIGNADA` |

### Credencial del jurado

Definida en [`shared/src/credencial.ts`](../shared/src/credencial.ts) (solo Node). Formato `v1.{jurado}.{vence}.{firma}`, con `firma = base64url(HMAC-SHA256(JURADO_SECRETO, "v1.{jurado}.{vence}"))`. El servidor no confía en `acta.jurado`: toma el jurado de la credencial verificada, exige que coincida y usa ese valor para el límite de tasa. Las 8 réplicas comparten el secreto por variable de entorno, sin estado de sesión.

- `POST /actas`: cabecera `Authorization: Bearer {credencial}`.
- `WS /ws/jurados`: el navegador no permite cabeceras en el WebSocket, así que la credencial viaja como segundo valor de `Sec-WebSocket-Protocol`: `new WebSocket(url, ['preconteo.jurados.v1', credencial])`. El servidor acepta solo el subprotocolo y no devuelve la credencial. **Nunca en la URL**, que queda en logs de proxies. Sin una credencial válida, el upgrade se rechaza con 401 antes de abrir el socket.
- Emisión: `JURADO_SECRETO=… npm run credenciales -w @preconteo/herramientas -- --desde 1 --hasta 50` imprime un CSV con un enlace `/jurado/#credencial=…` por jurado (el fragmento no llega al servidor; la PWA lo borra de la barra de direcciones).
- La PWA guarda la credencial junto con cada acta en la cola offline. Si recibe `NO_AUTORIZADO`, conserva el acta hasta que se cargue una credencial válida.

Sin `JURADO_SECRETO` la verificación queda desactivada (desarrollo y pruebas) y el servidor lo avisa en el log al arrancar.

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
| `acta:{id}` | Hash | A | C | `version`, `estado`, `firma`, `votos`, `sufragantes`, `hash_foto`, `ts_cierre`, `votos_aplicados`, `recibo`, `conflicto` |
| `idem:{idem}` | String | A | A | recibo JSON, `EX 86400` |
| `cat:mesa:{n}` | Hash | A (generador) | A | `puesto`, `municipio` |
| `seq:recibo` | String | A | — | consecutivo de recibos |
| `rl:{credencial}:{ventana}` | String | A | — | contador, `EX 60` (jurado de la credencial verificada) |
| `jur:{jurado}:mesas` | Set | generador de catálogo | A | mesas asignadas al jurado |
| `verif:casos` | Hash | A crea y cierra, C asigna | C | campo = id del acta, valor = `CaseRecord` JSON (ver §8) |
| `verif:cola` | ZSET | A encola, C toma | C | miembro = id del acta, score = `receivedAt − priority·10¹⁰` (menor = más urgente) |
| `verif:asignados` | ZSET | C (A retira al cerrar) | C | miembro = id, score = vencimiento de la concesión |
| `st:verif` | Stream | A y C | C | eventos de la cola: `type`/`tipo`, `caseId`/`acta`, … |
| `lock:caso:{acta}`, `fence:caso:{acta}` | String | C (A borra el lock al cerrar) | A y C | `{auditor}:{token}` con `PX 30000`; contador de cercado |
| `pres:aud`, `pres:info` | ZSET, Hash | C | A y C | presencia de auditores |
| `resolucion:{acta}:{token}` | String | A | A | idempotencia de una resolución: `{ huella, recibo }` |

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

## 8. Verificación: casos y resolución (A ↔ C)

**Encolar (A).** Cuando una versión no cuadra (`DUDOSA_EN_VERIFICACION`) o choca con otra de la misma versión (`CONFLICTO_VERSION`), `aplicar_acta.lua` escribe en `verif:casos` un `CaseRecord` con `source: 'A'`, `status: 'pending'` y lo agrega a `verif:cola`, todo en la misma operación que registra el acta. Prioridad: 100 para conflictos; `min(99, 90 + descuadre)` para descuadres.

- Un caso abierto de la **misma versión** se conserva, con su dueño si lo tiene.
- Una **versión nueva** reemplaza el caso: se borra el lock y el token anterior queda obsoleto.
- Una versión **válida** del jurado cierra el caso abierto (`resolution.action = 'approve'`, nota «Superada…»).

**Tomar, renovar, liberar (C).** Scripts de [`server/src/verificacion/lua.ts`](../server/src/verificacion/lua.ts) sobre las mismas claves.

**Resolver (C → A).** La consola envía `resolve` con `{ caseId, token, resolution }`. C valida el mensaje y llama a `ResolucionAtomica` ([`server/src/ingesta/resolucion.ts`](../server/src/ingesta/resolucion.ts)), que ejecuta `aplicar_acta.lua` en modo `resolucion`. El script comprueba **dentro de la misma operación** que el caso esté asignado a ese auditor, sesión y token, que `lock:caso` y `fence:caso` coincidan, que el auditor tenga latido de menos de 30 s y actividad de menos de 10 min; luego aplica los votos y cierra el caso.

| `resolution.action` | Efecto en el preconteo | Recibo |
|---|---|---|
| `approve` | La mesa suma con los votos del caso | `REGISTRADA` |
| `correct` | La mesa suma con `resolution.votes` (todas las casillas) | `REGISTRADA` |
| `reject` | La mesa no suma (o deja de sumar) | `RECHAZADA` |

Respuestas a la consola: `APPLIED` (con `receipt`), `STALE_TOKEN` (la concesión ya no es vigente: un auditor tardío no pisa al dueño nuevo), `INVALID_CASE`, `INVALID_VOTES`, `RESOLUTION_CONFLICT` (la misma toma ya se resolvió con otra decisión) o `UNAVAILABLE`. Repetir la misma orden devuelve el mismo recibo sin volver a sumar.

En `DEMO_MODE=true`, C usa sus casos de ejemplo con el prefijo `demo:` y las resoluciones quedan en `PENDING_A`; la conexión con A se activa con `DEMO_MODE=false`.

