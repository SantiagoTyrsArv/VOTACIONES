import { createClient } from 'redis';
import type { FastifyBaseLogger } from 'fastify';

export type RedisClient = ReturnType<typeof createClient>;

/**
 * Conexiones separadas por tipo de uso, como exige node-redis:
 *  - commands: comandos normales y scripts Lua.
 *  - subscriber: queda en modo SUBSCRIBE y no puede ejecutar otros comandos.
 *  - blocking: lecturas bloqueantes (XREAD BLOCK) sin frenar a "commands".
 */
export class RedisConnections {
  readonly commands: RedisClient;
  readonly subscriber: RedisClient;
  readonly blocking: RedisClient;

  constructor(
    url: string,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.commands = RedisConnections.create(url);
    this.subscriber = this.commands.duplicate();
    this.blocking = this.commands.duplicate();
    for (const [name, client] of this.entries()) {
      client.on('error', (error: Error) => this.logger.warn({ err: error.message }, `Redis (${name}) con error`));
      client.on('reconnecting', () => this.logger.warn(`Redis (${name}) reconectando...`));
      client.on('ready', () => this.logger.info(`Redis (${name}) listo`));
    }
  }

  private static create(url: string): RedisClient {
    return createClient({
      url,
      // Sin cola offline: si Redis está caído el comando falla de inmediato (RF-10),
      // en lugar de quedarse esperando y dejar al jurado creyendo que transmitió.
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 3_000,
        reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 3_000),
      },
    });
  }

  private entries(): Array<[string, RedisClient]> {
    return [
      ['commands', this.commands],
      ['subscriber', this.subscriber],
      ['blocking', this.blocking],
    ];
  }

  async connect(): Promise<void> {
    await Promise.all(this.entries().map(([, client]) => client.connect()));
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      this.entries().map(([, client]) => (client.isReady ? client.quit() : client.disconnect())),
    );
  }
}
