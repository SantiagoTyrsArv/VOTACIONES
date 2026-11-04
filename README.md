# VOTACIONES · Preconteo electoral en tiempo real

Sistema de preconteo para una jornada electoral departamental: **6.400 mesas**, **1.842 puestos**, hasta **400.000 navegadores** mirando resultados y **120 auditores** verificando actas dudosas, repartidos en **8 instancias Node.js sin sesiones pegajosas** que solo se coordinan por **Redis**.

> Proyecto del taller de WebSockets · Programación Orientada a la Web · Ingeniería de Software, séptimo semestre.

## Qué resuelve

Un mismo hecho (entra un acta) debe llegar con garantías distintas a tres audiencias:

| Audiencia | Transporte | Garantía |
|---|---|---|
| Jurados (6.400, red móvil pobre) | WebSocket + `POST /actas` de respaldo + cola offline en IndexedDB | El acta cuenta **una sola vez** y el jurado sabe con certeza si quedó registrada |
| Auditores (120) | WebSocket | Nunca dos auditores sobre la misma acta; un auditor caído libera su caso |
| Público (400.000) | Server-Sent Events (+ polling de respaldo) | El número no retrocede sin explicación; quien reconecta ve lo mismo que quien nunca se fue |

```
 Jurados ──WS──┐        Auditores ──WS──┐        Público ──SSE──┐
               ▼                        ▼                       ▼
        ┌──────────── Balanceador (sin afinidad) ────────────────────┐
        │  instancia 1 … instancia 8  (idénticas, sin estado propio) │
        └──────────────────────────┬─────────────────────────────────┘
                                   ▼
   Redis 7: script Lua atómico · hashes + ZSET · streams · Pub/Sub · bloqueos · presencia
```

## Estructura del repositorio

| Carpeta | Contenido | Dueño |
|---|---|---|
| [`shared/`](shared/) | **Contrato**: tipos de mensajes, claves de Redis, validación del acta | Los tres |
| `server/` | Servidor Fastify + `ws` + SSE; módulos de ingesta, difusión y verificación | A / B / C |
| `jurado/` | PWA del jurado con cola offline | A |
| `herramientas/` | Generador de catálogo y de jornada simulada | A |
| `publico/` | Página pública de resultados | B |
| `auditores/` | Consola de verificación | C |
| `carga/` | Pruebas de carga k6 (20.000 conexiones) | C |
| [`docs/`](docs/) | Diseño, contrato y secciones del informe | Los tres |

## Empezar

Requisitos: Node.js ≥ 22 y Docker.

```bash
npm install            # instala todos los workspaces
npm run redis:up       # Redis 7 local con AOF everysec
npm test               # pruebas de todos los workspaces
```

Cada módulo explica cómo correrlo en su propio README.

## Documentación

- [Contrato compartido](docs/contrato.md): mensajes, claves de Redis y quién escribe qué.
- [Arquitectura](docs/arquitectura.md): decisiones de transporte, papeles de Redis y reparto.
- [Cómo contribuir](CONTRIBUTING.md): ramas, commits, revisión cruzada.

## Equipo

| Persona | Responsabilidad | Requerimientos |
|---|---|---|
| A · Ingesta y consistencia | Recibir y consolidar actas | RF-1, RF-2, RF-3, RF-10 (Redis caído), RT-6 |
| B · Difusión pública | Llevar los resultados al público | RF-4, RF-5, RF-6, RF-9, RF-10 (avalancha), RT-4, RT-5, RT-9 |
| C · Verificación y plataforma | Auditores, despliegue y métricas | RF-7, RF-8, RT-1, RT-2, RT-3, RT-7, RT-8, RT-10 |
