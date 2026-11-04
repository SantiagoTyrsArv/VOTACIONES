import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import type { PublicTransport } from '../connections/PublicConnection.js';
import type { EventLoopDelaySample } from './EventLoopMonitor.js';

export type BackpressureAction = 'atrasada' | 'reanudada' | 'desconectada';

/** Resumen legible para /publico/stats y para el informe. */
export interface DifusionStatsSnapshot {
  instance: string;
  connections: Record<PublicTransport, number>;
  messagesSent: number;
  messagesPerSecond: number;
  naiveEquivalentMessages: number;
  reductionFactor: number | null;
  bytesSent: number;
  actaNotices: number;
  eventLoop: EventLoopDelaySample;
  memoryPerConnectionBytes: number | null;
  backpressure: Record<BackpressureAction, number>;
  admissionRejected: number;
}

/**
 * Instrumentación de la difusión pública (RT-4, RT-7). Se exporta en /metrics (Prometheus)
 * y además se guarda en contadores simples para el resumen JSON de /publico/stats.
 */
export class DifusionMetrics {
  private readonly messages: Counter<'kind' | 'transport'>;
  private readonly bytes: Counter;
  private readonly naive: Counter;
  private readonly notices: Counter;
  private readonly latency: Histogram;
  private readonly fanoutDuration: Histogram<'mode'>;
  private readonly backpressureCounter: Counter<'action'>;
  private readonly admission: Counter;
  private readonly eventLoopGauge: Gauge<'quantile'>;
  private readonly memoryPerConnection: Gauge;
  private readonly inp: Histogram<'rating'>;

  private totals = { messages: 0, bytes: 0, naive: 0, notices: 0, admissionRejected: 0 };
  private readonly backpressureTotals: Record<BackpressureAction, number> = { atrasada: 0, reanudada: 0, desconectada: 0 };
  private rate = { lastAtMs: Date.now(), lastMessages: 0, perSecond: 0 };
  private eventLoop: EventLoopDelaySample = { p50Ms: 0, p99Ms: 0, maxMs: 0, atMs: Date.now() };

  constructor(
    registry: Registry,
    private readonly instanceId: string,
    private readonly connectionCount: () => Record<PublicTransport, number>,
  ) {
    const countConnections = this.connectionCount;
    new Gauge({
      name: 'public_connections',
      help: 'Conexiones públicas abiertas en esta instancia',
      labelNames: ['transport'],
      registers: [registry],
      // Se calcula al momento de cada lectura de /metrics
      collect() {
        for (const [transport, count] of Object.entries(countConnections())) this.set({ transport }, count);
      },
    });
    this.messages = new Counter({
      name: 'public_messages_sent_total',
      help: 'Mensajes enviados al público (cada envío a cada conexión cuenta uno)',
      labelNames: ['kind', 'transport'],
      registers: [registry],
    });
    this.bytes = new Counter({ name: 'public_bytes_sent_total', help: 'Bytes de carga útil enviados al público', registers: [registry] });
    this.naive = new Counter({
      name: 'public_naive_equivalent_messages_total',
      help: 'Mensajes que habría enviado el fan-out ingenuo (un mensaje por acta por conexión)',
      registers: [registry],
    });
    this.notices = new Counter({ name: 'public_acta_notices_total', help: 'Avisos recibidos por ch:actas', registers: [registry] });
    this.latency = new Histogram({
      name: 'public_acta_to_publish_ms',
      help: 'Retraso entre la recepción de un acta y su publicación al público',
      buckets: [50, 100, 250, 500, 1000, 2000, 3000, 5000, 8000, 13000],
      registers: [registry],
    });
    this.fanoutDuration = new Histogram({
      name: 'public_fanout_duration_ms',
      help: 'Duración de cada fan-out de un tópico',
      labelNames: ['mode'],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
      registers: [registry],
    });
    this.backpressureCounter = new Counter({
      name: 'public_backpressure_events_total',
      help: 'Acciones de contrapresión sobre clientes lentos',
      labelNames: ['action'],
      registers: [registry],
    });
    this.admission = new Counter({
      name: 'public_admission_rejected_total',
      help: 'Conexiones rechazadas por el control de admisión (503 + Retry-After)',
      registers: [registry],
    });
    this.eventLoopGauge = new Gauge({
      name: 'event_loop_delay_ms',
      help: 'Retraso del Event Loop medido con monitorEventLoopDelay',
      labelNames: ['quantile'],
      registers: [registry],
    });
    this.memoryPerConnection = new Gauge({
      name: 'public_memory_per_connection_bytes',
      help: 'Memoria residente del proceso dividida entre las conexiones abiertas',
      registers: [registry],
    });
    this.inp = new Histogram({
      name: 'public_page_inp_ms',
      help: 'INP reportado por la página pública (web-vitals)',
      labelNames: ['rating'],
      buckets: [50, 100, 200, 300, 500, 800, 1200, 2000],
      registers: [registry],
    });
  }

  messageSent(kind: string, transport: PublicTransport, bytes: number): void {
    this.messages.inc({ kind, transport });
    this.bytes.inc(bytes);
    this.totals.messages++;
    this.totals.bytes += bytes;
  }

  /** Cada aviso de acta equivale, en el modelo ingenuo, a un mensaje por conexión abierta. */
  actaNoticeReceived(openConnections: number): void {
    this.notices.inc();
    this.naive.inc(openConnections);
    this.totals.notices++;
    this.totals.naive += openConnections;
  }

  publishLatency(ms: number): void {
    if (ms >= 0) this.latency.observe(ms);
  }

  fanoutCompleted(mode: string, durationMs: number): void {
    this.fanoutDuration.observe({ mode }, durationMs);
  }

  backpressure(action: BackpressureAction): void {
    this.backpressureCounter.inc({ action });
    this.backpressureTotals[action]++;
  }

  admissionRejected(): void {
    this.admission.inc();
    this.totals.admissionRejected++;
  }

  eventLoopSample(sample: EventLoopDelaySample): void {
    this.eventLoop = sample;
    this.eventLoopGauge.set({ quantile: 'p50' }, sample.p50Ms);
    this.eventLoopGauge.set({ quantile: 'p99' }, sample.p99Ms);
    this.eventLoopGauge.set({ quantile: 'max' }, sample.maxMs);
    this.updateRateAndMemory();
  }

  pageInp(valueMs: number, rating: string): void {
    this.inp.observe({ rating }, valueMs);
  }

  snapshot(): DifusionStatsSnapshot {
    const connections = this.connectionCount();
    return {
      instance: this.instanceId,
      connections,
      messagesSent: this.totals.messages,
      messagesPerSecond: this.rate.perSecond,
      naiveEquivalentMessages: this.totals.naive,
      reductionFactor: this.totals.messages > 0 ? Math.round(this.totals.naive / this.totals.messages) : null,
      bytesSent: this.totals.bytes,
      actaNotices: this.totals.notices,
      eventLoop: this.eventLoop,
      memoryPerConnectionBytes: this.memoryPerConnectionBytes(connections),
      backpressure: { ...this.backpressureTotals },
      admissionRejected: this.totals.admissionRejected,
    };
  }

  private updateRateAndMemory(): void {
    const now = Date.now();
    const elapsed = (now - this.rate.lastAtMs) / 1000;
    if (elapsed > 0) {
      this.rate.perSecond = Math.round((this.totals.messages - this.rate.lastMessages) / elapsed);
      this.rate = { lastAtMs: now, lastMessages: this.totals.messages, perSecond: this.rate.perSecond };
    }
    const perConnection = this.memoryPerConnectionBytes(this.connectionCount());
    if (perConnection !== null) this.memoryPerConnection.set(perConnection);
  }

  private memoryPerConnectionBytes(connections: Record<PublicTransport, number>): number | null {
    const total = connections.sse + connections.ws;
    return total > 0 ? Math.round(process.memoryUsage().rss / total) : null;
  }
}
