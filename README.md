# VOTACIONES · Preconteo electoral en tiempo real

Taller de WebSockets · Programación Orientada a la Web · Ingeniería de Software, séptimo semestre.

Un acta debe llegar con garantías distintas a jurados, auditores y público, atravesando **8 instancias de Node.js sin sesiones pegajosas** que solo se coordinan por **Redis**.

| Integrante | Rol | Responsabilidad |
|---|---|---|
| Santiago Arévalo | Persona A · Ingesta y consistencia | Jurados, idempotencia, correcciones y acumulados |
| David Ramírez | Persona B · Difusión pública | SSE/WS/polling, fan-out, continuidad y contrapresión |
| Camila Zambrano | Persona C · Verificación y plataforma | Auditores, bloqueo, presencia, despliegue, métricas y carga |

## Estructura

- `shared/`: contratos, tópicos, claves y mensajes.
- `server/src/`: infraestructura y difusión comunes.
- `server/`: implementación independiente actual de verificación C.
- `publico/`: página pública B.
- `web/`: consola de auditores C.
- `carga/`: perfiles y generadores de carga.

## Verificación y pruebas

Requisitos: Node.js 22, Docker y Redis de pruebas en el puerto 6380.

```bash
npm ci --ignore-scripts
docker run -d --name votaciones-c-redis-tests -p 127.0.0.1:6380:6379 redis:7.4-alpine
npm run check
npm run validate:deploy
```

`npm run check` comprueba los módulos comunes y C, compila y ejecuta las pruebas contra Redis real.

## Demostración de C

```bash
docker compose up -d --build
docker compose run --rm seed
```

Abre `http://localhost:8080`. Entra como Ana y Luis en pestañas distintas para comprobar la toma exclusiva; Coordinación muestra presencia y plataforma. Los datos demo usan un prefijo separado.

Las resoluciones responden `PENDING_A` hasta conectar la operación atómica de A. La carga completa de 20.000 conexiones no se afirma como ejecutada.

## Difusión pública B

Rutas: `GET /publico/sse?topics=dep`, `GET /publico/poll?topics=dep`, `WS /ws/publico?topics=dep` y `GET /publico/stats`. El historial vive en Redis Streams; Pub/Sub solo actúa como aviso. La reconexión usa cursores por tópico y full jitter.

Para desarrollar sin el script de A: `npm run alimentar -w carga -- --redis=<REDIS_URL> --acelerar=60 --reiniciar`.

## Integración pendiente

C se desarrolló desde la base inicial. La reconciliación de esta PR conserva sus pruebas y comandos, pero el traslado de C al `AppModule` y `UpgradeRouter` comunes sigue siendo necesario antes de afirmar que A/B/C ejecutan en un único servidor. Los pasos están en `docs/integracion.txt`.

Más detalle: `docs/contratos.txt`, `docs/plataforma.txt`, `docs/pruebas.txt`, `carga/uso.txt` y `docs/FLUJO_GIT.md`.
