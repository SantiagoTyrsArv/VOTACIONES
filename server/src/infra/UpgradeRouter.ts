import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Reparte las peticiones "Upgrade: websocket" por ruta. Cada módulo registra la suya
 * (/ws/jurado, /ws/auditor, /ws/publico) y comparten el mismo servidor HTTP.
 */
export class UpgradeRouter {
  private readonly handlers = new Map<string, UpgradeHandler>();

  register(path: string, handler: UpgradeHandler): void {
    if (this.handlers.has(path)) throw new Error(`Ruta de upgrade duplicada: ${path}`);
    this.handlers.set(path, handler);
  }

  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const handler = this.handlers.get(path);
      if (!handler) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      handler(request, socket, head);
    });
  }
}
