import type { WebSocket } from 'ws';
import { WS_CLOSE_RECONNECT_WITH_CURSOR, type StreamId } from '@votaciones/shared';
import type { EncodedMessage } from './EncodedMessage.js';
import { PublicConnection } from './PublicConnection.js';

/**
 * Variante WebSocket del canal público. No es el transporte elegido para el público
 * (es SSE), pero existe para medir y comparar los tres transportes con el mismo servidor.
 */
export class WsPublicConnection extends PublicConnection {
  private alive = true;

  constructor(
    private readonly socket: WebSocket,
    topics: Iterable<string>,
    cursors: ReadonlyMap<string, StreamId>,
  ) {
    super('ws', topics, cursors);
    socket.on('close', () => this.handleClosed());
    socket.on('error', () => this.handleClosed());
    socket.on('pong', () => {
      this.alive = true;
    });
  }

  get pendingBytes(): number {
    return this.socket.bufferedAmount;
  }

  protected write(message: EncodedMessage): void {
    this.socket.send(message.asJson);
  }

  /** Ping/pong: si no respondió al anterior, la conexión está muerta y se cierra. */
  heartbeat(): void {
    if (!this.isOpen) return;
    if (!this.alive) {
      this.socket.terminate();
      this.handleClosed();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  protected terminate(reason: string): void {
    // Código 4008: "vuelve con continuidad" (el cliente reconecta enviando sus cursores)
    this.socket.close(WS_CLOSE_RECONNECT_WITH_CURSOR, reason.slice(0, 120));
  }
}
