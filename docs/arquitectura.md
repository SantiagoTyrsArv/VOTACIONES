# Arquitectura

Resumen del documento de diseño *"Preconteo electoral en tiempo real — Diseño y reparto del trabajo"* (3 nov 2026).

## Restricciones duras

- Al menos 8 instancias en la nube detrás de un balanceador.
- Sin sesiones pegajosas.
- Ninguna instancia habla con otra salvo por Redis.
- Fan-out por lotes cediendo el Event Loop.
- Al menos dos transportes distintos conviviendo.
- Prueba de carga de 20.000 conexiones en el repositorio.
- URL pública verificable sin el grupo.

## Transporte por audiencia

| Audiencia | Transporte | Motivo |
|---|---|---|
| Jurados | WebSocket (`ws`) + `POST /actas` de respaldo | Respuesta inequívoca por acta sin un handshake HTTP por envío; el acta vive en IndexedDB hasta recibir el recibo |
| Auditores | WebSocket (`ws`) | Colaborativo: tomar casos, presencia y renovación del bloqueo por el mismo canal |
| Público | SSE + polling de respaldo | Solo recibe; reconexión y `Last-Event-ID` nativos; HTTP normal sin estado pegajoso |

No se usa Socket.IO: oculta el envío por lotes y el búfer pendiente por conexión, y con long polling exige afinidad.

## Recorrido de un acta

1. El jurado la envía por WebSocket (o `POST /actas`) a **cualquier** instancia.
2. La instancia valida el formato, aplica el límite de tasa y ejecuta `aplicar_acta.lua`.
3. El script, de forma atómica: comprueba idempotencia y versión, aplica el delta en mesa, puesto, municipio y departamento, actualiza los rankings, escribe los streams, guarda el recibo y publica el aviso en `ch:actas`.
4. El jurado recibe el recibo, que solo se envía **después** de que el script terminó.
5. Las 8 instancias reciben el aviso y, en su siguiente ventana de agregación, leen el stream y envían un mensaje condensado por SSE a sus suscriptores.

## Stack

Node.js 22 + TypeScript, Fastify, `ws`, SSE escrito a mano, Redis 7 (una instancia, AOF `everysec`), `node-redis`, PWA con Vite, k6 para la carga y despliegue en Azure Container Apps con 8 réplicas (ver [despliegue-azure.md](despliegue-azure.md); Railway se descartó por costo).

## Reparto

| | A · Ingesta | B · Difusión | C · Verificación y plataforma |
|---|---|---|---|
| RF | 1, 2, 3, 10 (Redis caído) | 4, 5, 6, 9, 10 (avalancha) | 7, 8 |
| RT | 6 | 4, 5, 9 | 1, 2, 3, 7, 8, 10 |
| Redis | Acumulados, script atómico, idempotencia, límite de tasa | Backplane, historial | Bloqueo, presencia, despliegue |
