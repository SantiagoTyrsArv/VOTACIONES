# VOTACIONES · Preconteo electoral en tiempo real

Taller de WebSockets · Programación Orientada a la Web · Ingeniería de Software, séptimo semestre.

Un acta que entra debe llegar, con garantías distintas, a tres audiencias (jurados, auditores y público),
atravesando **8 instancias de Node.js sin sesiones pegajosas** que solo se coordinan por **Redis**.

| Integrante | Rol | Responsabilidad |
|---|---|---|
| Santiago Arévalo | Persona A · Ingesta y consistencia | Jurados, `aplicar_acta.lua`, idempotencia, correcciones, acumulados (RF-1, RF-2, RF-3, RT-6) |
| David Ramírez | Persona B · Difusión pública | Público: SSE/WS/polling, fan-out por lotes, continuidad, contrapresión, jitter (RF-4, RF-5, RF-6, RF-9, RF-10, RT-4, RT-5, RT-9) |
| Camila Zambrano | Persona C · Verificación y plataforma | Auditores, bloqueo y presencia, despliegue con 8 réplicas, métricas, carga (RF-7, RF-8, RT-1, RT-2, RT-3, RT-7, RT-8, RT-10) |

## Arquitectura

```mermaid
flowchart TB
    subgraph Clientes
        J["Jurados · 6.400<br/>PWA con cola offline"]
        AU["Auditores · 120<br/>consola colaborativa"]
        P["Público · hasta 400.000<br/>página ligera"]
    end

    LB["Balanceador (Railway)<br/>reparto al azar, SIN sesiones pegajosas"]

    J <-->|WebSocket /ws/jurado| LB
    AU <-->|WebSocket /ws/auditor| LB
    P -->|"SSE /publico/sse (+ polling de respaldo)"| LB

    subgraph Instancias["8 instancias Node.js idénticas (no se hablan entre sí)"]
        direction LR
        I1["Instancia 1<br/>Ingesta · Difusión · Verificación · Métricas"]
        I2["Instancia 2"]
        I8["... Instancia 8"]
    end

    LB --> I1
    LB --> I2
    LB --> I8

    subgraph Redis["Redis 7 · columna vertebral"]
        LUA["Script Lua aplicar_acta<br/>(atómico)"]
        TOT["Hashes tot:* + ZSET rank:*<br/>acumulados y ranking"]
        ST["Streams st:dep / st:mun:m / st:pue:p<br/>historial con ids monótonos"]
        PS["Pub/Sub ch:actas / ch:verif<br/>solo 'timbre' (sin memoria)"]
        LK["lock:caso / pres:aud / idem / rl<br/>bloqueos, presencia, idempotencia, tasa"]
    end

    I1 -->|EVALSHA| LUA
    LUA --> TOT
    LUA --> ST
    LUA --> PS
    PS -->|SUBSCRIBE| I1
    PS -->|SUBSCRIBE| I2
    PS -->|SUBSCRIBE| I8
    I2 -->|XRANGE al agregar o reconectar| ST
    I8 --> LK
```

### Recorrido de un acta

```mermaid
sequenceDiagram
    autonumber
    participant J as Jurado (PWA)
    participant IA as Instancia X
    participant R as Redis
    participant IB as Instancia Y
    participant P as Público (SSE)

    J->>IA: acta {idem, version, votos} por WebSocket
    IA->>R: EVALSHA aplicar_acta.lua
    Note over R: valida, compara versión, aplica delta en<br/>mesa/puesto/municipio/departamento,<br/>XADD a los streams, PUBLISH ch:actas
    R-->>IA: REGISTRADA + recibo
    IA-->>J: recibo (el acta sale de la cola local)
    R-->>IB: aviso en ch:actas (tópicos tocados)
    Note over IB: marca el tópico "sucio" y cada 2 s (5 s el departamental)<br/>lee XRANGE desde su último id y condensa
    IB->>P: UN mensaje por tópico y ventana, enviado por lotes
```

## Estructura del repositorio

```
VOTACIONES/
├── shared/      Contrato común: tópicos, claves de Redis, canales y formatos de mensaje
├── server/      Instancia Node.js (Fastify + ws). Cada persona tiene su módulo:
│   └── src/
│       ├── infra/         Esqueleto común: Redis, salud, upgrades WS, módulos
│       ├── ingesta/       Persona A
│       ├── difusion/      Persona B
│       └── verificacion/  Persona C
├── publico/     Página pública (Persona B)
├── jurado/      PWA del jurado (Persona A)
├── consola/     Consola de auditores (Persona C)
└── carga/       Pruebas de carga y herramientas de medición
```

## Cómo ejecutar

Requisitos: Node.js 22 y una URL de Redis (el de Railway sirve también para desarrollo).

```bash
npm install
cp .env.example .env      # y poner REDIS_URL
npm run build
npm start                 # producción
npm run dev               # desarrollo con recarga
npm test
```

Rutas comunes de cada instancia: `/whoami` (RT-1), `/live`, `/ready` (503 si Redis no responde), `/metrics` (Prometheus).

## Difusión pública (Persona B)

```mermaid
flowchart LR
    R[(Redis<br/>st:* streams<br/>tot:* hashes)] -- "PUBLISH ch:actas (timbre)" --> T[DirtyTopicTracker]
    T --> S["AggregationScheduler<br/>ventana 2 s · 5 s dep"]
    R -- "XRANGE (cursor +" --> S
    S --> C["DeltaCondenser<br/>N actas → 1 mensaje"]
    C --> B["PublicBroadcaster<br/>lotes de 500 / 5 ms<br/>+ contrapresión"]
    B --> G["TopicRegistry<br/>Map&lt;tópico, Set&lt;conexión&gt;&gt;"]
    G --> P1[SSE] & P2[WebSocket]
    N[Cliente reconecta<br/>?cursor=dep@id,mun:11@id] --> U["CatchUpService<br/>delta o fotografía"]
    R --> U
```

| Ruta | Uso |
|---|---|
| `GET /publico/` | Página pública (`?mun=11`, `?pue=176`, `?transporte=sse\|ws\|poll`) |
| `GET /publico/sse?topics=dep,mun:11&cursor=...` | Server-Sent Events (transporte del público) |
| `GET /publico/poll?topics=...&cursor=...` | Polling (respaldo y comparación) |
| `WS /ws/publico?topics=...&cursor=...` | WebSocket (solo para comparar transportes) |
| `GET /publico/stats` | Conexiones, mensajes reales vs. ingenuos, retraso del Event Loop |

Decisiones clave:

- **Un mensaje por tópico y ventana**, con valores **absolutos** de los campos que cambiaron: idempotente y sin huecos aunque un cliente se salte deltas.
- **Cursor por tópico** (`tópico@idDeStream`): cada mensaje lleva el id de su tópico y el cliente arma el cursor compuesto, que envía en `?cursor=` al reconectar. Los ids de Redis Streams son comunes a las 8 instancias, así que se puede reconectar a cualquiera.
- **Fotografía** en lugar de detalle si el cursor fue recortado, hay más de 200 entradas pendientes o la ausencia supera 5 min. Si una fotografía baja un número, la página muestra un aviso de correcciones.
- **Pub/Sub solo como timbre**: la fuente de verdad son los Streams; además se releen cada 15 s por si se pierde un aviso.
- **Reconexión con full jitter** y rotación SSE entre 12 y 14 min (Railway corta a los 15 min).
- **Contrapresión**: más de 64 KB pendientes deja la conexión atrasada; por debajo de 16 KB se le manda una fotografía; más de 1 MB o 60 s atrasada se desconecta con orden de reconexión.

Para desarrollar sin el script de A: `npm run alimentar -w carga -- --redis=<REDIS_URL> --acelerar=60 --reiniciar`
(imita `aplicar_acta.lua` con el mismo contrato de `shared/`).

## Flujo de trabajo con Git

Ver [docs/FLUJO_GIT.md](docs/FLUJO_GIT.md).
