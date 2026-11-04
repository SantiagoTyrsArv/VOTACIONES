import type { BackpressurePolicy } from '../backpressure/BackpressurePolicy.js';
import type { EncodedMessage } from '../connections/EncodedMessage.js';
import type { PublicConnection } from '../connections/PublicConnection.js';
import type { BatchFanout, FanoutResult } from './BatchFanout.js';

export interface BroadcastResult extends FanoutResult {
  delivered: number;
  lagged: number;
  disconnected: number;
}

export interface BroadcastObserver {
  onDelivered(connection: PublicConnection, message: EncodedMessage): void;
  onLagging(connection: PublicConnection): void;
  onDisconnected(connection: PublicConnection): void;
}

/**
 * Une el recorrido por lotes con la política de contrapresión: decide, conexión por
 * conexión, si se envía, si se marca atrasada o si se desconecta.
 */
export class PublicBroadcaster {
  constructor(
    private readonly fanout: BatchFanout,
    private readonly policy: BackpressurePolicy,
    private readonly observer: BroadcastObserver,
  ) {}

  /**
   * Envía a los suscriptores al día. Las conexiones "sincronizando" o "atrasadas" se
   * saltan: recibirán su propia puesta al día y no deben ver un delta con hueco.
   */
  async broadcast(recipients: Iterable<PublicConnection>, message: EncodedMessage): Promise<BroadcastResult> {
    let delivered = 0;
    let lagged = 0;
    let disconnected = 0;
    const result = await this.fanout.forEach(recipients, (connection) => {
      if (!connection.isOpen || connection.syncState !== 'al_dia') return;
      switch (this.policy.beforeSend(connection)) {
        case 'enviar':
          connection.send(message);
          delivered++;
          this.observer.onDelivered(connection, message);
          break;
        case 'atrasar':
          connection.markLagging(Date.now());
          lagged++;
          this.observer.onLagging(connection);
          break;
        case 'desconectar':
          connection.close('contrapresion', 0);
          disconnected++;
          this.observer.onDisconnected(connection);
          break;
      }
    });
    return { ...result, delivered, lagged, disconnected };
  }

  /** Avisos de estado (congelado / descongelado): llegan a todos, sin importar su sincronía. */
  async announce(recipients: Iterable<PublicConnection>, message: EncodedMessage): Promise<FanoutResult> {
    return this.fanout.forEach(recipients, (connection) => {
      if (connection.isOpen && this.policy.beforeSend(connection) !== 'desconectar') {
        connection.send(message);
        this.observer.onDelivered(connection, message);
      }
    });
  }

  /** Latidos para que proxies y balanceadores no corten conexiones SSE inactivas. */
  async heartbeat(recipients: Iterable<PublicConnection>): Promise<FanoutResult> {
    return this.fanout.forEach(recipients, (connection) => connection.heartbeat());
  }
}
