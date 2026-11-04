import Fastify, { type FastifyInstance } from 'fastify';
import { Registry, collectDefaultMetrics } from 'prom-client';
import type { AppConfig } from '../config/AppConfig.js';
import type { AppModule, ModuleContext } from './AppModule.js';
import { RedisConnections } from './RedisConnections.js';
import { RedisHealthMonitor, withTimeout } from './RedisHealthMonitor.js';
import { UpgradeRouter } from './UpgradeRouter.js';

/**
 * Composición de la instancia: crea la infraestructura común y arranca los módulos.
 * Las instancias no se conocen entre sí; solo comparten Redis (RT-3).
 */
export class Application {
  private readonly http: FastifyInstance;
  private readonly redis: RedisConnections;
  private readonly health: RedisHealthMonitor;
  private readonly upgrades = new UpgradeRouter();
  private readonly metrics = new Registry();

  constructor(
    private readonly config: AppConfig,
    private readonly modules: AppModule[],
  ) {
    this.http = Fastify({ logger: { level: config.logLevel }, disableRequestLogging: true });
    this.redis = new RedisConnections(config.redisUrl, this.http.log);
    this.health = new RedisHealthMonitor(this.redis.commands);
    this.metrics.setDefaultLabels({ instance: config.instanceId });
    collectDefaultMetrics({ register: this.metrics });
  }

  async start(): Promise<void> {
    this.registerPlatformRoutes();
    const context: ModuleContext = {
      config: this.config,
      http: this.http,
      upgrades: this.upgrades,
      redis: this.redis,
      health: this.health,
      metrics: this.metrics,
    };
    for (const module of this.modules) {
      await module.register(context);
      this.http.log.info(`Módulo registrado: ${module.name}`);
    }

    this.upgrades.attach(this.http.server);
    await this.connectRedisWithoutBlocking();
    this.health.start();
    for (const module of this.modules) await module.start?.();

    await this.http.listen({ port: this.config.port, host: '::' });
    this.http.log.info(`Instancia ${this.config.instanceId} escuchando en el puerto ${this.config.port}`);
  }

  async stop(): Promise<void> {
    this.health.stop();
    for (const module of [...this.modules].reverse()) await module.stop?.();
    await this.http.close();
    await this.redis.close();
  }

  /**
   * Si Redis no está disponible al arrancar, la instancia igual levanta en modo degradado
   * (RF-10) y node-redis sigue reintentando en segundo plano.
   */
  private async connectRedisWithoutBlocking(): Promise<void> {
    const connecting = this.redis.connect();
    connecting.catch(() => undefined);
    try {
      await withTimeout(connecting, 3_000);
    } catch (error) {
      this.http.log.error({ err: (error as Error).message }, 'Redis no disponible al arrancar: modo degradado');
    }
  }

  private registerPlatformRoutes(): void {
    // RT-1: permite comprobar desde varios clientes en qué instancia cayó cada uno.
    this.http.get('/whoami', async () => ({ instance: this.config.instanceId, pid: process.pid }));
    // /live siempre 200 para que la plataforma no reinicie las 8 instancias en bucle si Redis cae.
    this.http.get('/live', async () => ({ status: 'vivo', instance: this.config.instanceId }));
    // /ready refleja si esta instancia puede consolidar actas.
    this.http.get('/ready', async (_request, reply) => {
      const ready = this.health.isHealthy;
      return reply.code(ready ? 200 : 503).send({ ready, redis: ready ? 'ok' : 'caido', instance: this.config.instanceId });
    });
    this.http.get('/metrics', async (_request, reply) => {
      return reply.type(this.metrics.contentType).send(await this.metrics.metrics());
    });
  }
}
