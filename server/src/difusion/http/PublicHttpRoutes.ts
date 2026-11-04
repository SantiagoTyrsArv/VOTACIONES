import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AdmissionController } from '../admission/AdmissionController.js';
import { SseConnection } from '../connections/SseConnection.js';
import type { CatchUpEvent, CatchUpService } from '../continuity/CatchUpService.js';
import type { DifusionMetrics } from '../metrics/DifusionMetrics.js';
import { InvalidSubscriptionError, SubscriptionRequest } from '../topics/SubscriptionRequest.js';
import type { PublicConnection } from '../connections/PublicConnection.js';

interface SubscriptionQuery {
  topics?: string;
  cursor?: string;
}

interface InpBody {
  value?: number;
  rating?: string;
}

/** Lo que las rutas necesitan del módulo. */
export interface PublicRouteDeps {
  instanceId: string;
  admission: AdmissionController;
  catchUp: CatchUpService;
  metrics: DifusionMetrics;
  isFrozen: () => boolean;
  frozenSinceMs: () => number | null;
  attach: (connection: PublicConnection) => void;
  extraStats: () => Record<string, unknown>;
  publicDir: string | null;
}

/**
 * Rutas HTTP del público:
 *   GET  /publico/sse    → Server-Sent Events (transporte elegido para el público)
 *   GET  /publico/poll   → polling (línea base de comparación y respaldo)
 *   POST /publico/inp    → la página reporta su INP medido (RT-9)
 *   GET  /publico/stats  → resumen JSON de esta instancia (mediciones del informe)
 *   GET  /publico/       → página pública estática
 */
export class PublicHttpRoutes {
  constructor(private readonly deps: PublicRouteDeps) {}

  async register(http: FastifyInstance): Promise<void> {
    http.get<{ Querystring: SubscriptionQuery }>('/publico/sse', (request, reply) => {
      const admission = this.deps.admission.tryAdmit();
      if (!admission.admitted) {
        this.deps.metrics.admissionRejected();
        return reply
          .code(503)
          .header('Retry-After', String(admission.retryAfterSec))
          .send({ error: 'Instancia saturada, reintente más tarde', retryAfterSec: admission.retryAfterSec });
      }
      const subscription = this.parse(request.query, request.headers['last-event-id'], reply);
      if (!subscription) return reply;

      // A partir de aquí la respuesta es nuestra: Fastify no la cierra.
      reply.hijack();
      const connection = SseConnection.open(reply.raw, subscription.topics, subscription.cursors, this.deps.instanceId);
      this.deps.attach(connection);
      return reply;
    });

    http.get<{ Querystring: SubscriptionQuery }>('/publico/poll', async (request, reply) => {
      const subscription = this.parse(request.query, undefined, reply);
      if (!subscription) return reply;
      reply.header('Cache-Control', 'no-store');
      const frozenReply = (): FastifyReply =>
        reply.code(503).send({
          instance: this.deps.instanceId,
          events: [{ type: 'status', frozen: true, sinceMs: this.deps.frozenSinceMs() ?? Date.now(), instance: this.deps.instanceId }],
        });
      if (this.deps.isFrozen()) return frozenReply();
      const events: CatchUpEvent[] = [];
      try {
        for (const topic of subscription.topics) {
          const event = await this.deps.catchUp.resume(topic, subscription.cursors.get(topic) ?? null);
          if (event) {
            events.push(event);
            this.deps.metrics.messageSent(event.type, 'poll', Buffer.byteLength(JSON.stringify(event)));
          }
        }
      } catch {
        // Redis falló entre sondeos de salud: respuesta degradada explícita, nunca un silencio
        return frozenReply();
      }
      return { instance: this.deps.instanceId, events };
    });

    http.post<{ Body: InpBody }>('/publico/inp', async (request, reply) => {
      const value = Number(request.body?.value);
      if (!Number.isFinite(value) || value < 0 || value > 60_000) return reply.code(400).send({ error: 'INP inválido' });
      this.deps.metrics.pageInp(value, String(request.body?.rating ?? 'desconocido').slice(0, 20));
      return reply.code(204).send();
    });

    http.get('/publico/stats', async () => ({ ...this.deps.metrics.snapshot(), ...this.deps.extraStats() }));

    await this.registerStaticPage(http);
  }

  private parse(query: SubscriptionQuery, lastEventId: string | string[] | undefined, reply: FastifyReply): SubscriptionRequest | null {
    try {
      return SubscriptionRequest.parse({
        topics: query.topics,
        cursor: query.cursor,
        lastEventId: Array.isArray(lastEventId) ? lastEventId[0] : lastEventId,
      });
    } catch (error) {
      if (error instanceof InvalidSubscriptionError) {
        void reply.code(400).send({ error: error.message });
        return null;
      }
      throw error;
    }
  }

  /** Sirve publico/dist si existe (después de "npm run build"). */
  private async registerStaticPage(http: FastifyInstance): Promise<void> {
    const root = this.deps.publicDir ?? fileURLToPath(new URL('../../../../publico/dist', import.meta.url));
    if (!existsSync(root)) {
      http.log.warn(`No se encontró la página pública en ${root}; ejecute "npm run build -w publico"`);
      return;
    }
    await http.register(fastifyStatic, { root, prefix: '/publico/', decorateReply: false });
  }
}
