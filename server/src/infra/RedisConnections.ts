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
      // Un solo aviso por caída: sin esto, cada reintento llenaría el log.
      let reportedDown = false;
      client.on('error', (error: Error) => {
        if (reportedDown) return;
        reportedDown = true;
        this.logger.warn(
          { err: error.message || error.name },
          `Redis (${name}) no disponible; reintentando en segundo plano`,
        );
      });
      client.on('ready', () => {
        reportedDown = false;
        this.logger.info(`Redis (${name}) listo`);
      });
    }
  }

  private static create(url: string): RedisClient {
    return createClient({
      url,
      // Sin cola offline: si Redis está caído el comando falla de inmediato (RF-10),
      // en lugar de quedarse esperando y dejar al jurado creyendo que transmitió.
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
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
      this.entries().map(([, client]) => (client.isOpen ? client.disconnect() : undefined)),
    );
  }
}
