import type { ActaNotice } from '@votaciones/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AppModule, ModuleContext } from '../infra/AppModule.js';
import type { RedisHealthChange } from '../infra/RedisHealthMonitor.js';
import { AdmissionController } from './admission/AdmissionController.js';
import { AggregationScheduler } from './aggregation/AggregationScheduler.js';
import { DeltaCondenser } from './aggregation/DeltaCondenser.js';
import { DirtyTopicTracker } from './aggregation/DirtyTopicTracker.js';
import { BackpressurePolicy } from './backpressure/BackpressurePolicy.js';
import type { EncodedMessage } from './connections/EncodedMessage.js';
import type { PublicConnection } from './connections/PublicConnection.js';
import { CatchUpService } from './continuity/CatchUpService.js';
import { ConnectionSynchronizer } from './continuity/ConnectionSynchronizer.js';
import { ResultsStreamReader } from './continuity/ResultsStreamReader.js';
import { TopicCursorBook } from './continuity/TopicCursorBook.js';
import { DifusionSettings } from './DifusionSettings.js';
import { BatchFanout } from './fanout/BatchFanout.js';
import { PublicBroadcaster, type BroadcastObserver } from './fanout/PublicBroadcaster.js';
import { PublicHttpRoutes } from './http/PublicHttpRoutes.js';
import { PublicWebSocketGateway } from './http/PublicWebSocketGateway.js';
import { DifusionMetrics } from './metrics/DifusionMetrics.js';
import { EventLoopMonitor } from './metrics/EventLoopMonitor.js';
import { FreezeAnnouncer } from './status/FreezeAnnouncer.js';
import { TopicRegistry } from './topics/TopicRegistry.js';

/**
 * Módulo de difusión pública (Persona B): RF-4, RF-5, RF-6, RF-9, RF-10 (avalancha), RT-4, RT-5.
 *
 * Ciclo de vida de una conexión pública:
 *   1. Admisión (máx. N nuevas/s) → 503 + Retry-After aleatorio si se excede.
 *   2. Registro en sus tópicos en estado "sincronizando".
 *   3. Puesta al día desde su cursor (delta condensado o fotografía) → "al día".
 *   4. Cada ventana recibe un delta por tópico, enviado por lotes.
 *   5. Si su búfer crece → "atrasada"; al vaciarse recibe una fotografía; si no, se desconecta.
 */
export class DifusionModule implements AppModule {
  readonly name = 'difusion (Persona B · público)';

  private readonly registry = new TopicRegistry<PublicConnection>();
  private readonly cursors = new TopicCursorBook();
  private readonly lagging = new Set<PublicConnection>();
  private readonly unsynced = new Set<PublicConnection>();
  private readonly timers: NodeJS.Timeout[] = [];

  private context!: ModuleContext;
  private settings!: DifusionSettings;
  private logger!: FastifyBaseLogger;
  private metrics!: DifusionMetrics;
  private eventLoop!: EventLoopMonitor;
  private broadcaster!: PublicBroadcaster;
  private policy!: BackpressurePolicy;
  private synchronizer!: ConnectionSynchronizer;
  private tracker!: DirtyTopicTracker;
  private scheduler!: AggregationScheduler;
  private freeze!: FreezeAnnouncer;
  private wsGateway!: PublicWebSocketGateway;

  async register(context: ModuleContext): Promise<void> {
    this.context = context;
    this.logger = context.http.log.child({ modulo: 'difusion' });
    this.settings = DifusionSettings.from(context.config);
    const instanceId = context.config.instanceId;

    this.metrics = new DifusionMetrics(context.metrics, instanceId, () => this.countByTransport());
    this.eventLoop = new EventLoopMonitor();
    this.eventLoop.onSample((sample) => this.metrics.eventLoopSample(sample));

    const reader = new ResultsStreamReader(context.redis.commands);
    const condenser = new DeltaCondenser(instanceId);
    const catchUp = new CatchUpService(reader, condenser, instanceId, this.settings.catchUp);
    const fanout = new BatchFanout(this.settings.fanout);
    this.policy = new BackpressurePolicy(this.settings.backpressure);
    this.broadcaster = new PublicBroadcaster(fanout, this.policy, this.broadcastObserver());
    this.synchronizer = new ConnectionSynchronizer(catchUp, this.cursors, {
      onCatchUpSent: (connection, message) => this.countSent(connection, message),
    });
    this.tracker = new DirtyTopicTracker(
      context.redis.subscriber,
      (topic) => this.registry.hasSubscribers(topic),
      () => this.registry.activeTopics,
      (notice) => this.onActaNotice(notice),
      this.logger,
    );
    this.scheduler = new AggregationScheduler(
      this.registry, this.tracker, reader, condenser, this.cursors, this.broadcaster,
      this.metrics, fanout.mode, this.logger, this.settings.aggregation,
    );
    this.freeze = new FreezeAnnouncer(instanceId);

    const admission = new AdmissionController(this.settings.admissionPerSecond);
    const attach = (connection: PublicConnection): void => this.attach(connection);
    await new PublicHttpRoutes({
      instanceId,
      admission,
      catchUp,
      metrics: this.metrics,
      isFrozen: () => this.freeze.isFrozen,
      frozenSinceMs: () => this.freeze.frozenSinceMs,
      attach,
      extraStats: () => ({
        topics: this.registry.topicCount,
        lagging: this.lagging.size,
        unsynced: this.unsynced.size,
        frozen: this.freeze.isFrozen,
        fanoutMode: fanout.mode,
      }),
      publicDir: this.settings.publicDir,
    }).register(context.http);
    this.wsGateway = new PublicWebSocketGateway(admission, this.metrics, attach);
    this.wsGateway.register(context.upgrades);
  }

  stats() { return this.metrics.snapshot(); }

  async start(): Promise<void> {
    this.eventLoop.start();
    this.context.health.on('change', (change) => void this.onHealthChange(change));
    this.tracker.start();
    this.scheduler.start();
    this.every(this.settings.heartbeatMs, () => void this.broadcaster.heartbeat(this.registry.all));
    this.every(this.settings.laggingSweepMs, () => this.sweepLagging());
    this.logger.info(`Difusión pública lista (fan-out en modo ${this.settings.fanout.mode})`);
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.scheduler.stop();
    this.eventLoop.stop();
    this.wsGateway.close();
    for (const connection of [...this.registry.all]) connection.close('instancia_apagandose', 1_000);
  }

  /** Alta de una conexión nueva (SSE o WebSocket). */
  private attach(connection: PublicConnection): void {
    this.registry.add(connection);
    connection.onClose(() => this.detach(connection));
    if (connection.transport === 'sse') this.limitLifetime(connection);
    if (this.freeze.isFrozen) {
      connection.send(this.freeze.currentStatus());
      this.unsynced.add(connection);
      return;
    }
    void this.synchronize(connection, 'continuar');
  }

  /**
   * Railway corta las respuestas HTTP a los 15 min. El cliente rota solo entre 12 y 14 min;
   * esto es la red de seguridad: si no lo hizo, el servidor cierra ordenadamente (con orden
   * de reconexión) en un instante aleatorio entre 14 y 14,5 min, antes del corte abrupto.
   */
  private limitLifetime(connection: PublicConnection): void {
    const { maxSseLifetimeMs, sseLifetimeJitterMs } = this.settings;
    const timer = setTimeout(() => connection.close('rotacion_programada', 0), maxSseLifetimeMs + Math.random() * sseLifetimeJitterMs);
    timer.unref();
    connection.onClose(() => clearTimeout(timer));
  }

  private detach(connection: PublicConnection): void {
    for (const topic of this.registry.remove(connection)) this.cursors.forget(topic);
    this.lagging.delete(connection);
    this.unsynced.delete(connection);
  }

  private async synchronize(connection: PublicConnection, mode: 'continuar' | 'fotografia'): Promise<void> {
    const ok = await this.synchronizer.synchronize(connection, mode);
    if (ok) this.unsynced.delete(connection);
    else if (connection.isOpen) this.unsynced.add(connection);
  }

  private onActaNotice(_notice: ActaNotice): void {
    this.metrics.actaNoticeReceived(this.registry.size);
  }

  /** RF-10: Redis cayó o volvió. */
  private async onHealthChange(change: RedisHealthChange): Promise<void> {
    const status = this.freeze.update(change.healthy, change.sinceMs);
    if (!status) return;
    this.logger.warn(change.healthy ? 'Redis volvió: se descongela el público' : 'Redis no responde: público congelado');
    await this.broadcaster.announce(this.registry.all, status);
    if (change.healthy) {
      this.tracker.markAll();
      for (const connection of [...this.unsynced]) await this.synchronize(connection, 'continuar');
    }
  }

  /** RF-9: revisa cada segundo las conexiones atrasadas. */
  private sweepLagging(): void {
    const now = Date.now();
    for (const connection of [...this.lagging]) {
      switch (this.policy.whileLagging(connection, now)) {
        case 'desconectar':
          this.lagging.delete(connection);
          this.metrics.backpressure('desconectada');
          connection.close('contrapresion', 0);
          break;
        case 'reanudar':
          this.lagging.delete(connection);
          this.metrics.backpressure('reanudada');
          void this.synchronize(connection, 'fotografia');
          break;
        case 'esperar':
          break;
      }
    }
  }

  private broadcastObserver(): BroadcastObserver {
    return {
      onDelivered: (connection, message) => this.countSent(connection, message),
      onLagging: (connection) => {
        this.lagging.add(connection);
        this.metrics.backpressure('atrasada');
      },
      onDisconnected: () => this.metrics.backpressure('desconectada'),
    };
  }

  private countSent(connection: PublicConnection, message: EncodedMessage): void {
    this.metrics.messageSent(message.event.type, connection.transport, message.byteLength);
  }

  private countByTransport(): { sse: number; ws: number } {
    const counts = { sse: 0, ws: 0 };
    for (const connection of this.registry.all) counts[connection.transport]++;
    return counts;
  }

  private every(ms: number, task: () => void): void {
    const timer = setInterval(task, ms);
    timer.unref();
    this.timers.push(timer);
  }
}
