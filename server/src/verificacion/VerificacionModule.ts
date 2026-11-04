import type { IncomingMessage } from 'node:http';
import type { ModuleContext, AppModule } from '../infra/AppModule.js';
import fastifyStatic from '@fastify/static';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  caseInputSchema,
  clientMessageSchema,
  PROTOCOL_VERSION,
  type Identity,
  type ServerMessage,
  type Snapshot,
} from '@votaciones/shared/verificacion';
import type { Config } from './config.js';
import { VerificationStore, type Actor } from './store.js';
import { PendingAAdapter, receiveDoubtfulCase, type ResolutionAdapter } from './integration.js';
import { RuntimeMetrics, type PublicStatsSource } from './metrics.js';

/** Señales de A y B para el tablero (RT-7): actas/min y latencia acta → público. */
export interface PlatformSignals {
  onActaAccepted?(listener: () => void): void;
  onPublicLatency?(listener: (ms: number) => void): void;
  /** Jornada simulada de A, controlada por coordinación (RT-10). */
  simulation?: SimulationControl;
}

export interface SimulationControl {
  readonly habilitada: boolean;
  estado(): Promise<unknown>;
  iniciar(o: {
    aceleracion: number;
    reiniciar: boolean;
  }): Promise<{ ok: boolean; motivo?: string }>;
  detener(): Promise<boolean>;
}

const equalSecret = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
async function registerVerification(
  context: ModuleContext,
  config: Config,
  adapter: ResolutionAdapter,
  publicStats?: PublicStatsSource,
  signals: PlatformSignals = {},
) {
  const app = context.http;
  const store = new VerificationStore(config, context.redis);
  const metrics = new RuntimeMetrics(store, context.metrics, publicStats);
  signals.onActaAccepted?.(() => metrics.recordAcceptedActa());
  signals.onPublicLatency?.((ms) => metrics.recordPublicLatency(ms));
  const pendingSignals = [
    ...(signals.onActaAccepted ? [] : ['actas/min: conectar A']),
    ...(signals.onPublicLatency ? [] : ['latencia acta → público: conectar B']),
  ];
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
  });
  const route = (path: string, handler: (socket: WebSocket, req: IncomingMessage) => void) => {
    context.upgrades.register(path, (request, socket, head) => {
      wsServer.handleUpgrade(request, socket, head, (ws) => handler(ws, request));
    });
  };
  const connections = new Set<WebSocket>();
  let stopping = false,
    broadcastPending = false,
    sweepBusy = false,
    metricsBusy = false;
  const timers: NodeJS.Timeout[] = [];
  function send(socket: WebSocket, message: Omit<ServerMessage, 'protocol' | 'instance'>) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 65536) {
      socket.close(4008, 'Reconecte para recuperar el estado');
      return;
    }
    socket.send(
      JSON.stringify({ protocol: PROTOCOL_VERSION, instance: config.instance, ...message }),
    );
    metrics.sent();
  }
  async function notify() {
    if (broadcastPending || stopping) return;
    broadcastPending = true;
    try {
      let index = 0;
      for (const socket of connections) {
        send(socket, { type: 'changed' });
        if (++index % 50 === 0) await yieldLoop();
      }
    } finally {
      broadcastPending = false;
    }
  }
  const snapshot = async (): Promise<Snapshot> => {
    const [cases, presence, serverTime] = await Promise.all([
      store.cases(),
      store.people(),
      store.now(),
    ]);
    return {
      cases,
      presence,
      serverTime,
      integration: { status: adapter.status, detail: adapter.detail },
      demo: config.demo,
    };
  };
  function credentialIdentity(credential: string): Identity | undefined {
    return Object.hasOwn(config.credentials, credential)
      ? config.credentials[credential]
      : undefined;
  }
  const bearer = (authorization?: string) =>
    authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  // /metrics (Prometheus) solo para coordinación, como /api/metrics.
  context.authorizeMetrics((token) => credentialIdentity(token)?.role === 'coordinator');
  app.get('/api/state', async (req, reply) => {
    if (!credentialIdentity(bearer(req.headers.authorization)))
      return reply.code(401).send({ code: 'UNAUTHORIZED' });
    return snapshot();
  });
  app.get('/api/metrics', async (req, reply) => {
    if (credentialIdentity(bearer(req.headers.authorization))?.role !== 'coordinator')
      return reply.code(403).send({ code: 'FORBIDDEN' });
    return {
      instances: await metrics.all(),
      expectedReplicas: Number(process.env.EXPECTED_REPLICAS || 2),
      pending: pendingSignals,
    };
  });
  const simulation = signals.simulation;
  // Solo con SIMULACION_HABILITADA=true: sin la bandera las rutas no existen (404).
  if (simulation?.habilitada) {
    const isCoordinator = (authorization?: string) =>
      credentialIdentity(bearer(authorization))?.role === 'coordinator';
    app.get('/api/demo/jornada', async (req, reply) => {
      if (!isCoordinator(req.headers.authorization))
        return reply.code(403).send({ code: 'FORBIDDEN' });
      return simulation.estado();
    });
    app.post('/api/demo/jornada', async (req, reply) => {
      if (!isCoordinator(req.headers.authorization))
        return reply.code(403).send({ code: 'FORBIDDEN' });
      const body = (req.body ?? {}) as {
        accion?: unknown;
        aceleracion?: unknown;
        reiniciar?: unknown;
      };
      if (body.accion === 'detener') return { ok: await simulation.detener() };
      const aceleracion = Number(body.aceleracion);
      if (
        body.accion !== 'iniciar' ||
        !Number.isFinite(aceleracion) ||
        aceleracion < 1 ||
        aceleracion > 600
      )
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      const result = await simulation.iniciar({ aceleracion, reiniciar: body.reiniciar === true });
      return reply.code(result.ok ? 202 : 409).send(result);
    });
  }
  app.post('/api/integration/cases', async (req, reply) => {
    if (
      !config.integrationToken ||
      !equalSecret(bearer(req.headers.authorization), config.integrationToken)
    )
      return reply.code(401).send({ code: 'UNAUTHORIZED' });
    const parsed = caseInputSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.source !== 'A' || config.demo)
      return reply.code(400).send({ code: 'INVALID_CASE_OR_MODE' });
    const result = await receiveDoubtfulCase(store, parsed.data);
    return reply.code(result.code === 'CASE_CONFLICT' ? 409 : 200).send(result);
  });
  for (const path of ['/ws/auditor', '/ws/auditors'])
    route(path, (socket, req) => {
      const origin = req.headers.origin;
      if (
        origin &&
        (config.allowedOrigins.length
          ? !config.allowedOrigins.includes(origin)
          : (() => {
              try {
                return new URL(origin).host !== req.headers.host;
              } catch {
                return true;
              }
            })())
      ) {
        socket.close(1008, 'Origen no autorizado');
        return;
      }
      metrics.connections++;
      let actor: Actor | undefined,
        claim: { caseId: string; token: string } | undefined,
        alive = true,
        ended = false;
      let queue = Promise.resolve(),
        outstanding = 0,
        lastSync = 0;
      const authDeadline = setTimeout(() => socket.close(1008, 'Falta autenticación'), 5000);
      const ping = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 15000);
      socket.on('pong', () => {
        alive = true;
      });
      async function cleanup() {
        if (ended) return;
        ended = true;
        clearTimeout(authDeadline);
        clearInterval(ping);
        connections.delete(socket);
        metrics.connections--;
        if (actor && store.redis.isReady) await store.presence('leave', actor).catch(() => {});
        // Se deja caducar la concesión: un cierre tardío nunca libera el caso de una sesión nueva.
      }
      socket.on('close', () => {
        void queue.finally(cleanup);
      });
      socket.on('error', () => socket.terminate());
      socket.on('message', (raw) => {
        if (++outstanding > 30) {
          socket.close(1008, 'Demasiados mensajes pendientes');
          return;
        }
        queue = queue
          .then(async () => {
            if (ended || socket.readyState !== WebSocket.OPEN) return;
            metrics.received();
            let input: unknown;
            try {
              input = JSON.parse(raw.toString());
            } catch {
              send(socket, { type: 'error', code: 'INVALID_JSON' });
              return;
            }
            const parsed = clientMessageSchema.safeParse(input);
            if (!parsed.success) {
              send(socket, { type: 'error', code: 'INVALID_MESSAGE' });
              return;
            }
            const msg = parsed.data;
            if (!actor) {
              if (msg.type !== 'auth') {
                send(socket, { type: 'error', requestId: msg.requestId, code: 'UNAUTHORIZED' });
                return;
              }
              const identity = credentialIdentity(msg.credential);
              if (!identity) {
                send(socket, { type: 'error', requestId: msg.requestId, code: 'UNAUTHORIZED' });
                socket.close(1008);
                return;
              }
              actor = { identity, sessionId: randomUUID() };
              await store.presence('connect', actor);
              const owned = (await store.cases()).find(
                (c) => c.status === 'assigned' && c.owner === identity.id,
              );
              if (owned?.token) {
                const resumed = await store.operation('resume', owned.id, actor, owned.token);
                if (resumed.code === 'RESUMED') claim = { caseId: owned.id, token: owned.token };
              }
              clearTimeout(authDeadline);
              connections.add(socket);
              send(socket, { type: 'hello', identity, requestId: msg.requestId });
              send(socket, { type: 'snapshot', snapshot: await snapshot() });
              return;
            }
            if (msg.type === 'auth') {
              send(socket, {
                type: 'error',
                code: 'ALREADY_AUTHENTICATED',
                requestId: msg.requestId,
              });
              return;
            }
            if (msg.type === 'sync') {
              if (Date.now() - lastSync < 500) return;
              lastSync = Date.now();
              send(socket, {
                type: 'snapshot',
                snapshot: await snapshot(),
                requestId: msg.requestId,
              });
              return;
            }
            if (msg.type === 'heartbeat') {
              const status = await store.presence('beat', actor);
              if (status === 'SESSION_REPLACED') {
                send(socket, { type: 'error', code: status });
                socket.close(4001, 'Sesión reemplazada');
                return;
              }
              const renewed = claim
                ? await store.operation(
                    'renew',
                    claim.caseId,
                    actor,
                    claim.token,
                    msg.active ? '1' : '0',
                  )
                : { code: 'PRESENT' };
              send(socket, { type: 'ack', requestId: msg.requestId, ...renewed });
              return;
            }
            if (actor.identity.role !== 'auditor') {
              send(socket, { type: 'error', code: 'FORBIDDEN', requestId: msg.requestId });
              return;
            }
            const result =
              msg.type === 'take'
                ? await store.operation('take', msg.caseId, actor)
                : msg.type === 'release'
                  ? await store.operation('release', msg.caseId, actor, msg.token)
                  : await adapter.apply(store, {
                      caseId: msg.caseId,
                      token: msg.token,
                      actor,
                      resolution: msg.resolution,
                    });
            if (result.code === 'TAKEN' && result.token)
              claim = { caseId: msg.caseId, token: result.token };
            if (result.code === 'APPLIED' && !result.receipt)
              throw new Error('A no devolvió un recibo de aplicación');
            if (result.code === 'RELEASED' || result.code === 'APPLIED') claim = undefined;
            send(socket, {
              type: 'ack',
              requestId: msg.requestId,
              ...result,
              detail: result.code === 'PENDING_A' ? adapter.detail : undefined,
            });
            send(socket, { type: 'snapshot', snapshot: await snapshot() });
          })
          .catch((err) => {
            app.log.error({ err }, 'Falló una operación de C');
            send(socket, {
              type: 'error',
              code: 'UNAVAILABLE',
              detail: 'No se pudo confirmar la operación. Reconecte y consulte el estado.',
            });
          })
          .finally(() => {
            outstanding--;
          });
      });
    });
  // Banco de transporte: nunca ingresa actas ni adquiere permisos de auditor.
  if (config.demo)
    route('/ws/load', (socket) => {
      metrics.connections++;
      socket.on('message', (raw) => {
        metrics.received();
        if (socket.bufferedAmount <= 65536) {
          socket.send(raw.toString());
          metrics.sent();
        } else socket.close(4008);
      });
      socket.on('error', () => socket.terminate());
      socket.on('close', () => {
        metrics.connections--;
      });
    });
  const staticRoot = resolve(context.config.string('CONSOLE_DIR', 'web-dist'));
  if (existsSync(staticRoot))
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      index: 'index.html',
      decorateReply: false,
    });
  return {
    store,
    metrics,
    snapshot,
    async start() {
      await store.open(() => {
        void notify();
      });
      const sweepTimer = setInterval(() => {
        if (sweepBusy || stopping) return;
        sweepBusy = true;
        void store
          .sweep()
          .catch((err) => app.log.error({ err }, 'Falló el barrido'))
          .finally(() => {
            sweepBusy = false;
          });
      }, 5000);
      timers.push(sweepTimer);
      await metrics.publish().catch(() => {});
      timers.push(
        setInterval(() => {
          if (metricsBusy || stopping) return;
          metricsBusy = true;
          void metrics
            .publish()
            .catch(() => {})
            .finally(() => {
              metricsBusy = false;
            });
        }, 5000),
      );
    },
    async stop() {
      stopping = true;
      for (const timer of timers) clearInterval(timer);
      for (const client of wsServer.clients) client.terminate();
      wsServer.close();
      metrics.close();
      await store.close();
    },
  };
}

export class VerificacionModule implements AppModule {
  readonly name = 'verificacion';
  private runtime!: Awaited<ReturnType<typeof registerVerification>>;
  constructor(
    private readonly config: Config,
    private readonly adapter: ResolutionAdapter = new PendingAAdapter(),
    private readonly publicStats?: PublicStatsSource,
    private readonly signals: PlatformSignals = {},
  ) {}
  get store() {
    return this.runtime.store;
  }
  get metrics() {
    return this.runtime.metrics;
  }
  get snapshot() {
    return this.runtime.snapshot;
  }
  async register(context: ModuleContext) {
    this.runtime = await registerVerification(
      context,
      this.config,
      this.adapter,
      this.publicStats,
      this.signals,
    );
  }
  async start() {
    await this.runtime.start();
  }
  async stop() {
    await this.runtime.stop();
  }
}
