import type { ServerResponse } from 'node:http';
import type { StreamId } from '@votaciones/shared';
import type { EncodedMessage } from './EncodedMessage.js';
import { PublicConnection } from './PublicConnection.js';

const HEARTBEAT_FRAME = Buffer.from(':latido\n\n', 'utf8');

/**
 * Conexión Server-Sent Events escrita a mano sobre la respuesta HTTP cruda.
 * Ventajas frente a una librería: controlamos id:, retry:, latidos y medimos
 * res.writableLength (bytes pendientes) para la contrapresión de RF-9.
 */
export class SseConnection extends PublicConnection {
  private constructor(
    private readonly response: ServerResponse,
    topics: Iterable<string>,
    cursors: ReadonlyMap<string, StreamId>,
  ) {
    super('sse', topics, cursors);
    response.on('close', () => this.handleClosed());
  }

  static open(
    response: ServerResponse,
    topics: Iterable<string>,
    cursors: ReadonlyMap<string, StreamId>,
    instanceId: string,
  ): SseConnection {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform evita que proxies compriman o almacenen el flujo
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx y algunos balanceadores almacenan en búfer si no se les pide lo contrario
      'X-Accel-Buffering': 'no',
      'X-Instance': instanceId,
    });
    // El cliente maneja la reconexión con jitter; este retry alto solo evita que
    // EventSource reintente por su cuenta si el cliente no alcanzó a cerrarlo.
    response.write('retry: 60000\n\n');
    response.socket?.setNoDelay(true);
    return new SseConnection(response, topics, cursors);
  }

  get pendingBytes(): number {
    return this.response.writableLength;
  }

  protected write(message: EncodedMessage): void {
    this.response.write(message.asSseFrame);
  }

  heartbeat(): void {
    if (this.isOpen) this.response.write(HEARTBEAT_FRAME);
  }

  protected terminate(reason: string, retryAfterMs: number): void {
    const payload = JSON.stringify({ type: 'reconnect', reason, retryAfterMs });
    // Si el búfer está lleno, este último evento puede no llegar; el cliente igual
    // detecta el cierre y reconecta con sus cursores.
    this.response.end(`event: reconnect\ndata: ${payload}\n\n`);
  }
}
