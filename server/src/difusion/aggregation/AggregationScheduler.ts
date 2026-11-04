import { Topic } from '@votaciones/shared';
import type { FastifyBaseLogger } from 'fastify';
import { EncodedMessage } from '../connections/EncodedMessage.js';
import type { PublicConnection } from '../connections/PublicConnection.js';
import type { ResultsSource } from '../continuity/ResultsStreamReader.js';
import type { TopicCursorBook } from '../continuity/TopicCursorBook.js';
import type { PublicBroadcaster } from '../fanout/PublicBroadcaster.js';
import type { DifusionMetrics } from '../metrics/DifusionMetrics.js';
import type { TopicRegistry } from '../topics/TopicRegistry.js';
import type { DeltaCondenser } from './DeltaCondenser.js';
import type { DirtyTopicSource } from './DirtyTopicTracker.js';

export interface AggregationOptions {
  /** Ventana para municipios y puestos. */
  readonly windowMs: number;
  /** Ventana para el tópico departamental (el más caro: lo sigue casi todo el público). */
  readonly departmentWindowMs: number;
  /** Cada cuánto se releen todos los tópicos activos aunque no llegue aviso (Pub/Sub pierde). */
  readonly safetySweepMs: number;
  /** Entradas leídas por XRANGE en cada vuelta. */
  readonly readBatch: number;
}

export const DEFAULT_AGGREGATION: AggregationOptions = {
  windowMs: 2_000,
  departmentWindowMs: 5_000,
  safetySweepMs: 15_000,
  readBatch: 500,
};

const DEPARTMENT = Topic.DEPARTMENT.toString();

/**
 * La trampa de escala de RF-4: 6.400 actas × 400.000 clientes = 2.560 millones de mensajes.
 * En lugar de un mensaje por acta, cada instancia emite como máximo UN mensaje por tópico
 * y ventana, con el cambio acumulado. Un puesto con ~3,5 mesas genera ~4 mensajes en toda
 * la jornada para sus suscriptores; el departamental como mucho 1.440 (2 h / 5 s).
 */
export class AggregationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastDepartmentFlushMs = 0;
  private lastSafetySweepMs = Date.now();

  constructor(
    private readonly registry: TopicRegistry<PublicConnection>,
    private readonly tracker: DirtyTopicSource,
    private readonly results: ResultsSource,
    private readonly condenser: DeltaCondenser,
    private readonly cursors: TopicCursorBook,
    private readonly broadcaster: PublicBroadcaster,
    private readonly metrics: DifusionMetrics,
    private readonly fanoutMode: string,
    private readonly logger: FastifyBaseLogger,
    private readonly options: AggregationOptions = DEFAULT_AGGREGATION,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.options.windowMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Una ventana. Si la anterior sigue corriendo (pico extremo) se omite, no se apila. */
  async tick(nowMs = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (nowMs - this.lastSafetySweepMs >= this.options.safetySweepMs) {
        this.tracker.markAll();
        this.lastSafetySweepMs = nowMs;
      }
      const departmentDue = nowMs - this.lastDepartmentFlushMs >= this.options.departmentWindowMs;
      const topics = this.tracker.take((topic) => topic !== DEPARTMENT || departmentDue);
      if (topics.includes(DEPARTMENT)) this.lastDepartmentFlushMs = nowMs;
      for (const topic of topics) await this.flush(topic);
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'Ventana de agregación fallida; se reintentará');
    } finally {
      this.running = false;
    }
  }

  private async flush(topic: string): Promise<void> {
    // Sin suscriptores locales o sin nadie sincronizado todavía: no hay a quién enviar.
    if (!this.registry.hasSubscribers(topic) || !this.cursors.has(topic)) return;

    let from = this.cursors.get(topic);
    for (;;) {
      const records = await this.results.readAfter(topic, from, this.options.readBatch);
      const delta = this.condenser.condense(topic, from, records);
      if (!delta) return;

      const last = records.at(-1)!.id;
      // Se avanza ANTES de difundir: una conexión que termina de sincronizar durante el
      // fan-out verá que la ventana avanzó y hará otra puesta al día (sin huecos).
      this.cursors.advance(topic, last);
      const message = new EncodedMessage(delta);
      const result = await this.broadcaster.broadcast(this.registry.subscribersOf(topic), message);
      this.metrics.fanoutCompleted(this.fanoutMode, result.durationMs);
      this.metrics.publishLatency(Date.now() - delta.oldestReceivedAtMs);

      from = last;
      if (records.length < this.options.readBatch) return;
    }
  }
}
