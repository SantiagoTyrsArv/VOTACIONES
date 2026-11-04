import { EncodedMessage } from '../connections/EncodedMessage.js';
import type { PublicConnection } from '../connections/PublicConnection.js';
import type { CatchUpService } from './CatchUpService.js';
import type { TopicCursorBook } from './TopicCursorBook.js';

/** Vueltas máximas de puesta al día si la ventana de la instancia avanza mientras tanto. */
const MAX_ROUNDS = 3;

export interface SyncObserver {
  onCatchUpSent(connection: PublicConnection, message: EncodedMessage): void;
}

/**
 * Lleva una conexión de "sincronizando" (o "atrasada") a "al día".
 *
 * Invariante que protege: después de sincronizar, el cursor de la conexión es mayor o igual
 * al cursor de la instancia para ese tópico. Así el siguiente delta de la ventana
 * (from = cursor de la instancia) nunca tiene hueco para este cliente. Si la ventana avanzó
 * mientras leíamos Redis, se repite la puesta al día (como mucho MAX_ROUNDS veces).
 */
export class ConnectionSynchronizer {
  constructor(
    private readonly catchUp: CatchUpService,
    private readonly instanceCursors: TopicCursorBook,
    private readonly observer: SyncObserver,
  ) {}

  /**
   * @param mode "continuar" entrega lo perdido desde el cursor; "fotografia" fuerza el estado
   *             completo (se usa al reanudar un cliente lento, RF-9).
   * @returns true si quedó al día; false si Redis falló (se reintentará luego).
   */
  async synchronize(connection: PublicConnection, mode: 'continuar' | 'fotografia' = 'continuar'): Promise<boolean> {
    connection.markSynchronizing();
    try {
      for (const topic of [...connection.topics]) {
        for (let round = 0; round < MAX_ROUNDS && connection.isOpen; round++) {
          const event =
            mode === 'fotografia' && round === 0
              ? await this.catchUp.photograph(topic, 'contrapresion')
              : await this.catchUp.resume(topic, connection.cursorOf(topic));
          if (event) {
            const message = new EncodedMessage(event);
            connection.send(message);
            this.observer.onCatchUpSent(connection, message);
          }
          this.instanceCursors.adopt(topic, connection.cursorOf(topic));
          const windowStart = this.instanceCursors.get(topic);
          const clientCursor = connection.cursorOf(topic);
          const behindWindow = windowStart !== null && (clientCursor === null || windowStart.isAfter(clientCursor));
          if (!behindWindow) break;
        }
      }
    } catch {
      return false;
    }
    if (connection.isOpen) connection.markUpToDate();
    return true;
  }
}
