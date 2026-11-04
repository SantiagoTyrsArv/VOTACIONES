# Informe de ingesta y consistencia · Persona A

## Idempotencia

Cada envío lógico lleva un `idem` estable. `aplicar_acta.lua` consulta primero `idem:{idem}` y devuelve el recibo original si ya existe. Si la clave expiró, la versión y la firma guardadas en `acta:{id}` impiden el doble conteo. El recibo se escribe en la misma ejecución atómica que el registro; el servidor solo responde después de que Lua termina.

Una caída entre el registro y el ack no produce un efecto duplicado: la PWA conserva el acta y reintenta por cualquier instancia. Si la respuesta de Redis se pierde después de ejecutar el script, el reintento obtiene `YA_REGISTRADA` con el recibo original.

## Convergencia

Gana la versión más alta. Una corrección calcula `votos_nuevos − votos_aplicados` y aplica únicamente ese delta. Las versiones antiguas devuelven `VERSION_OBSOLETA`. La misma versión con contenido distinto se rechaza, se marca como conflicto y entra en la cola de verificación sin alterar los acumulados.

Una versión dudosa no suma. Si reemplaza una versión que sí sumaba, el delta retira sus votos con motivo `retiro_dudosa`; por eso el resultado final no depende del orden de llegada.

## Atomicidad

`aplicar_acta.lua` valida antes de escribir y luego actualiza en una sola ejecución: acta, mesa, puesto, municipio, departamento, rankings, streams, cola de verificación, recibo e idempotencia. Ninguna lectura puede observar solo una parte de la corrección. `leer_topico.lua` obtiene totales, ranking y último id en una única lectura atómica.

## Degradación

Los comandos tienen timeout, cola offline de node-redis desactivada y circuit breaker. Si Redis no consolida, la respuesta es `NO_REGISTRADA`; nunca se confirma optimistamente. `/ready` devuelve 503 y `/live` permanece disponible. La PWA mantiene el acta y reintenta con espera exponencial y jitter.

## Evidencia ejecutada

- 14 pruebas del contrato compartido.
- 25 pruebas del servidor: idempotencia, reenvíos ×5, seis permutaciones, regla contable, atomicidad concurrente, HTTP, WebSocket y circuit breaker.
- 2 pruebas de persistencia IndexedDB.
- 3 pruebas reales en Chromium: recibo en móvil, recuperación automática tras un corte de red y recarga offline con reintento posterior.
- TypeScript y compilación de producción de todos los módulos de A.

Comandos de reproducción: `npm test`, `npm run typecheck`, `npm run build` y `npm run test:e2e`.

## Integración pendiente fuera del alcance individual

La aprobación formal del contrato por B y C y la prueba de humo con difusión pública y auditoría dependen de las otras personas. La URL pública y las ocho réplicas pertenecen a C.
