# Traspaso del proyecto · 4 de noviembre de 2026

Registro de lo hecho en la sesión del 3–4 de noviembre (Santiago, Persona A, con Claude Code) y de lo que falta. Está pensado para que otro integrante del grupo siga sin perder contexto. Guía de referencia: *Preconteo electoral en tiempo real — Diseño y reparto del trabajo* (PDF del grupo).

---

## 1. Estado en una mirada

| Área | Estado |
|---|---|
| A · Ingesta (RF-1, RF-2, RF-3, RT-6) | Completa: Lua atómico, WS + POST, PWA offline, credenciales firmadas |
| B · Difusión (RF-4, RF-5, RF-6, RF-9, RT-4, RT-5, RT-9) | Completa (trabajo de B), integrada |
| C · Verificación (RF-7, RF-8, RT-7) | Completa e **integrada con A**: las actas dudosas llegan a la cola y las resoluciones se aplican de forma atómica |
| Integración A+B+C en un servidor | En `main` |
| Despliegue (RT-1, RT-2, RT-10) | Plantilla de **Azure Container Apps** lista; **falta ejecutarla** con la cuenta del grupo |
| Jornada simulada activable sin el grupo (RT-10) | PR #12 (CI y Sonar en verde) |
| Prueba de carga de 20.000 conexiones (RT-8) | **Pendiente** |
| Informe y mediciones | **Pendiente** |

**PRs:** #4 y #7–#11 fusionados en `main`; **#12 abierto** (jornada simulada). Railway se descartó por costo; el despliegue es en Azure for Students.

---

## 2. Qué se hizo, en orden

### PR #7 · Integración A+B+C (reemplaza al #4)
- El merge anterior (`41e1f19`) había tomado una versión vieja de C: 81 errores de tipos y verificación sin conectar. Se rehízo con la versión final de C (`8b725f3`). El #4 quedó marcado como fusionado al entrar con el #7.
- `server/src/main.ts` registra los tres módulos: `IngestaModule` (A), `DifusionModule` (B) y `VerificacionModule` (C).
- **CI** (`.github/workflows/ci.yml`): typecheck, build, pruebas de los workspaces, pruebas de C, Playwright, `npm audit` y validación de la plantilla de Azure. Usa Redis de servicio en el puerto 6380.
- **Seguridad:**
  - `/metrics` exige `Bearer` (`METRICS_TOKEN` o una credencial de coordinación).
  - `@fastify/static` subió a 10.1.8 por vulnerabilidades altas.
  - La credencial de la consola se guarda solo en memoria.

### PR #8 · Actas dudosas de A → cola de C (RF-7)
- `aplicar_acta.lua` escribe las actas dudosas y los conflictos como `CaseRecord` de C en `verif:casos` y los encola con la prioridad de C.
- Modo `resolucion` del mismo script:
  - comprueba lock, fencing token, sesión, latido y actividad del auditor;
  - aplica la decisión (aprobar, corregir o rechazar);
  - escribe el recibo y cierra el caso, **todo en una sola operación atómica**. Un auditor tardío recibe `STALE_TOKEN`.
- Contrato completo en `docs/contrato.md` §8.

### PR #9 · Autenticación de jurados + PWA servida
- Credencial `v1.{jurado}.{vence}.{firma}` (HMAC con `JURADO_SECRETO`), definida en `shared/src/credencial.ts`.
  - **POST:** `Authorization: Bearer`.
  - **WebSocket:** segundo valor de `Sec-WebSocket-Protocol` junto a `preconteo.jurados.v1`. **Nunca va en la URL.**
  - **Enlace o QR:** `/jurado/#credencial=…`; el fragmento no llega al servidor.
- Reglas nuevas en la ingesta:
  - El jurado sale de la credencial, no del cuerpo del acta.
  - Asignación `jur:{jurado}:mesas`.
  - Una sola acta por mesa (`cat:mesa:{n}.acta`).
  - El límite de tasa cuenta por credencial verificada.
- La PWA se sirve en `/jurado/`.
- Emisor de credenciales: `npm run credenciales -w @preconteo/herramientas`.

### PR #10 · Tablero RT-7
- A avisa cada acta aplicada (actas/min) y B avisa la latencia acta → público. C las muestra (`PlatformSignals`).

### PR #11 · Despliegue en Azure Container Apps
- `deploy/azure/main.bicep`:
  - app con N réplicas fijas sin afinidad de sesión, con sondas `/live` y `/ready`;
  - Redis 7 con TCP interno, contraseña y AOF en Azure Files;
  - Job manual para cargar el catálogo;
  - Log Analytics.
- Scripts en `deploy/azure/`: `desplegar.ps1` (genera secretos locales y despliega) y `escalar.ps1`.
- `.github/workflows/imagen.yml` publica la imagen en `ghcr.io/santiagotyrsarv/votaciones`.
- RT-1: el identificador de réplica sale de `CONTAINER_APP_REPLICA_NAME` (`idDeReplica()`).
- Guía completa en `docs/despliegue-azure.md`.

### PR #12 (abierto) · Jornada simulada activable (RT-10)
- `shared/src/jornada.ts` genera un plan reproducible con el perfil del documento:
  - 55 % en 40 min;
  - ráfagas de ~300/min;
  - reenvíos con el mismo `idem`;
  - ~180 correcciones;
  - 6–9 % de actas dudosas.
- `server/src/ingesta/jornada.ts` ejecuta el plan con la ingesta real en **una sola réplica** (candado en Redis).
- La consola de coordinación tiene el panel *Plataforma → Jornada simulada* (velocidad, borrar, detener, avance).
- Requiere `SIMULACION_HABILITADA=true`, porque escribe en los datos y entra a la ingesta sin credencial. En Azure se activa con el parámetro `simulacion` (por defecto `true`).
- Verificado: 6.400 actas (7.025 solicitudes) a ×600 en 12 s sin errores, y 432 actas dudosas en la cola.

---

## 3. Cómo correr el proyecto en local

Requisitos: Node 22, Docker Desktop.

```bash
npm install
docker compose up -d redis                                               # 6379 (usa compose.yaml)
docker run -d --name redis-pruebas-c -p 127.0.0.1:6380:6379 redis:7.4-alpine   # Redis de pruebas de C
npm run build                       # antes de test:c (la prueba combinada necesita web-dist/)
npm test                            # workspaces (125 pruebas) + C (17)
npx playwright install chromium && npm run test:e2e   # navegador (5)
```

Instancia completa con la jornada:

```bash
# PowerShell: $env:VAR="…"; en bash como prefijo
DEMO_MODE=false SIMULACION_HABILITADA=true \
AUDITOR_CREDENTIALS_JSON='{"credencial-de-coordinacion-larga":{"id":"coord","name":"Coordinación","role":"coordinator"}}' \
node server/dist/main.js
```

| Ruta | Qué es |
|---|---|
| `/` | Consola de auditores y coordinación |
| `/publico/` | Página pública |
| `/jurado/` | PWA del jurado |
| `/whoami` | Réplica que atendió |
| `/live`, `/ready` | Sondas |
| `/metrics` | Prometheus (con token) |

Variables de entorno: ver `.env.example`.
- `DEMO_MODE=true`: C usa sus casos de ejemplo (prefijo `demo:`) y las resoluciones quedan en `PENDING_A`.
- Sin `JURADO_SECRETO`: la ingesta acepta actas sin credencial (solo para desarrollo).

---

## 4. Estructura

```
shared/        contrato: acta, recibo, claves de Redis, mensajes, credencial (Node), jornada,
               verificacion/ (C)
server/src/
  ingesta/     A: servicio, http, ws-jurados, aplicar (puente al Lua), resolucion, autenticacion, jornada
  redis/lua/   aplicar_acta.lua, leer_topico.lua, limite_tasa.lua
  difusion/    B: ventanas, fan-out por lotes, SSE/WS/polling, continuidad, contrapresión
  verificacion/ C: VerificacionModule, store, lua (bloqueo y presencia), metrics
  infra/       Application, RedisConnections, salud, upgrades, estáticos
jurado/        PWA (Vite) con cola en IndexedDB y Service Worker
publico/       página pública (B)
web/           consola de auditores (React, C) → web-dist/
herramientas/  catálogo, jornada por HTTP y emisor de credenciales
carga/         alimentador sintético y scripts k6 (B/C)
tests/         pruebas de C (node --test, Redis 6380)
e2e/           Playwright
deploy/azure/  Bicep y scripts de despliegue
docs/          contrato, arquitectura, despliegue-azure, informe-ingesta, plataforma, pruebas
```

---

## 5. Pendiente (en orden sugerido)

1. **Fusionar el PR #12** (jornada simulada). CI y SonarCloud están en verde.
2. **Desplegar en Azure** (RT-1, RT-2, RT-10). Pasos completos en `docs/despliegue-azure.md`:
   - Poner **pública** la imagen en GitHub → Packages → `votaciones` → Package settings.
   - `winget install -e --id Microsoft.AzureCLI`, luego `az login` con la cuenta de estudiante.
   - `./deploy/azure/desplegar.ps1 -CargarCatalogo`. El primer intento (4 nov) falló porque `eastus2` no está permitida para la suscripción de estudiante. Ahora el script elige solo una región permitida.
   - **Guardar y compartir por un canal privado** `deploy/azure/.secretos.local.json`. No se versiona, y sin él no se pueden emitir credenciales de jurados ni entrar a la consola.
   - Comprobar `/whoami` desde varias pestañas (réplicas distintas) e iniciar la jornada desde la consola de coordinación.
   - Usar 1 réplica en el día a día y 8 solo para la carga y la sustentación (`escalar.ps1`). Así el crédito alcanza.
3. **SonarCloud:** marcar como *Safe* el hallazgo S6382 de `deploy/azure/main.bicep`. Pide exigir certificados de cliente en el Redis TCP interno, y exigirlos cortaría a las réplicas.
4. **Prueba de carga RT-8 (C, con A y B):**
   - 20.000 conexiones repartidas en 3–4 generadores k6 contra la URL de Azure con 8 réplicas. Ya hay scripts en `carga/` (`connections.js`, `public-sse.js`, `polling.js`, `electoral.js`).
   - Para la prueba conviene `cpu='1'` y `memoria='2Gi'` en `main.bicep`.
   - Registrar las evidencias en `docs/evidence/`.
5. **Mediciones del informe** (sección «qué medir» del documento):
   - SSE vs WS vs polling: memoria por conexión, CPU, bytes, latencia p50/p95, recuperación tras un corte de 30 s.
   - Jurados: WS vs POST con red degradada.
   - Avalancha de reconexión con y sin jitter.
   - Redis: `INFO stats`, `PUBSUB NUMSUB` y `MEMORY USAGE` de un stream lleno.
6. **Informe:**
   - Actualizar la sección de A (`docs/informe-ingesta.md`) con la resolución atómica, las credenciales y la jornada.
   - Sección de despliegue con la URL y las capturas.
   - Introducción y conclusiones.
7. Menores:
   - Aviso de Fastify `FSTDEP023` (`disableRequestLogging`).
   - Archivos de A sin formato de Prettier (el CI no lo exige).

---

## 6. Decisiones y cosas a tener en cuenta

- **Contrato del WebSocket de jurados:** `new WebSocket(url, ['preconteo.jurados.v1', credencial])`. Los clientes que pongan la credencial en la URL reciben 401.
- **Una sola acta por mesa:** el primer id registrado queda fijado. Otro id para esa mesa recibe `UBICACION_INCONSISTENTE`.
- **Resoluciones:**
  - `approve` suma los votos del caso.
  - `correct` necesita todas las casillas.
  - `reject` deja la mesa fuera del preconteo.
  - Repetir la misma orden devuelve el mismo recibo.
- **Jornada simulada:** usa semilla fija. Repetirla sin borrar reenvía los mismos `idem` (todo vuelve `YA_REGISTRADA`). Para empezar de cero, marcar «Borrar resultados».
- **Lección de Git:** `git checkout <stash> -- archivos` deja esos archivos en el índice. Revisar `git diff --cached` antes de cada commit. Para llevar arreglos a ramas apiladas, usar un merge normal: `-X ours` revierte fragmentos que no estaban en conflicto.
- **Revisión cruzada:** según el documento, A revisa a B, B revisa a C y C revisa a A. Los PRs de esta sesión los fusionó Santiago para avanzar; conviene que B y C revisen en `main` lo que tocó sus módulos:
  - C: `VerificacionModule` (rutas de la jornada, señales, `/metrics`) y `web/App.tsx` (panel de jornada, métricas, mensajes de resolución).
  - B: `DifusionMetrics.onPublishLatency`.
