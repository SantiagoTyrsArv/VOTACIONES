import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { InstanceMetrics } from '@votaciones/shared/verificacion';
import type { VerificationStore } from './store.js';

export type PublicStatsSource = () => {
  connections: { sse: number; ws: number };
  messagesSent: number;
};
export class RuntimeMetrics {
  readonly loop = monitorEventLoopDelay({ resolution: 20 });
  connections = 0;
  messagesIn = 0;
  messagesOut = 0;
  private lastMessages = 0;
  private lastAt = performance.now();
  private accepted: number[] = [];
  private latency: { at: number; ms: number }[] = [];
  private acceptedHook = false;
  private publicHook = false;
  private readonly gauges: Record<string, Gauge>;
  private readonly inCounter: Counter;
  private readonly outCounter: Counter;
  private readonly actaCounter: Counter;
  private readonly latencyHistogram: Histogram;
  constructor(
    readonly store: VerificationStore,
    readonly registry = new Registry(),
    private readonly publicStats?: PublicStatsSource,
  ) {
    this.registry.setDefaultLabels({ instance: store.config.instance });
    this.gauges = Object.fromEntries(
      [
        'connections',
        'messages_per_second',
        'rss_bytes',
        'heap_bytes',
        'event_loop_p50_ms',
        'event_loop_p99_ms',
        'event_loop_max_ms',
      ].map((name) => [
        name,
        new Gauge({ name: `votaciones_${name}`, help: name, registers: [this.registry] }),
      ]),
    );
    this.inCounter = new Counter({
      name: 'votaciones_messages_in_total',
      help: 'Mensajes recibidos',
      registers: [this.registry],
    });
    this.outCounter = new Counter({
      name: 'votaciones_messages_out_total',
      help: 'Mensajes enviados',
      registers: [this.registry],
    });
    this.actaCounter = new Counter({
      name: 'votaciones_actas_accepted_total',
      help: 'Hook de A: actas aplicadas',
      registers: [this.registry],
    });
    this.latencyHistogram = new Histogram({
      name: 'votaciones_acta_public_seconds',
      help: 'Hook de B: acta a público',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });
    this.loop.enable();
  }
  received() {
    this.messagesIn++;
    this.inCounter.inc();
  }
  sent() {
    this.messagesOut++;
    this.outCounter.inc();
  }
  // A llama solo tras una aplicación nueva, nunca ante reenvíos idempotentes.
  recordAcceptedActa() {
    this.acceptedHook = true;
    this.accepted.push(Date.now());
    this.actaCounter.inc();
  }
  // B llama cuando emite realmente el dato; occurredAt viene del acta original.
  recordPublicDelivery(occurredAt: number) {
    const ms = Date.now() - occurredAt;
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Timestamp de acta inválido');
    this.publicHook = true;
    this.latency.push({ at: Date.now(), ms });
    this.latencyHistogram.observe(ms / 1000);
  }
  sample(): InstanceMetrics {
    const now = performance.now(),
      memory = process.memoryUsage(),
      time = Date.now();
    const publicStats = this.publicStats?.();
    const publicConnections = publicStats
      ? publicStats.connections.sse + publicStats.connections.ws
      : 0;
    const connections = this.connections + publicConnections;
    const sent = this.messagesOut + (publicStats?.messagesSent ?? 0);
    const messages = this.messagesIn + sent;
    const rate = (messages - this.lastMessages) / ((now - this.lastAt) / 1000);
    this.lastMessages = messages;
    this.lastAt = now;
    this.accepted = this.accepted.filter((t) => time - t <= 60000);
    this.latency = this.latency.filter((t) => time - t.at <= 60000);
    const sorted = this.latency.map((t) => t.ms).sort((a, b) => a - b);
    const result: InstanceMetrics = {
      instance: this.store.config.instance,
      sampledAt: time,
      uptimeSeconds: process.uptime(),
      connections,
      verificationConnections: this.connections,
      publicConnections,
      messagesIn: this.messagesIn,
      messagesOut: sent,
      messagesPerSecond: rate,
      rssBytes: memory.rss,
      heapBytes: memory.heapUsed,
      rssBytesPerConnection: connections ? memory.rss / connections : null,
      eventLoopP50Ms: this.loop.percentile(50) / 1e6,
      eventLoopP99Ms: this.loop.percentile(99) / 1e6,
      eventLoopMaxMs: this.loop.max / 1e6,
      acceptedActasPerMinute: this.acceptedHook ? this.accepted.length : null,
      publicLatencyP95Ms:
        this.publicHook && sorted.length
          ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
          : null,
    };
    for (const [key, value] of Object.entries({
      connections: result.connections,
      messages_per_second: rate,
      rss_bytes: memory.rss,
      heap_bytes: memory.heapUsed,
      event_loop_p50_ms: result.eventLoopP50Ms,
      event_loop_p99_ms: result.eventLoopP99Ms,
      event_loop_max_ms: result.eventLoopMaxMs,
    }))
      this.gauges[key]!.set(value);
    this.loop.reset();
    return result;
  }
  async publish() {
    const sample = this.sample();
    await this.store.run(() =>
      this.store.redis
        .multi()
        .set(this.store.key(`metrics:instance:${sample.instance}`), JSON.stringify(sample), {
          EX: 15,
        })
        .zAdd(this.store.key('metrics:instances'), {
          score: sample.sampledAt,
          value: sample.instance,
        })
        .zRemRangeByScore(this.store.key('metrics:instances'), '-inf', sample.sampledAt - 86400000)
        .exec(),
    );
  }
  async all(): Promise<InstanceMetrics[]> {
    const now = await this.store.now();
    const ids = await this.store.run(() =>
      this.store.redis.zRangeByScore(this.store.key('metrics:instances'), now - 15000, '+inf'),
    );
    if (!ids.length) return [];
    const values = await this.store.run(() =>
      this.store.redis.mGet(ids.map((id) => this.store.key(`metrics:instance:${id}`))),
    );
    return values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v) as InstanceMetrics);
  }
  close() {
    this.loop.disable();
  }
}
