import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { UpgradeRouter } from '../../infra/UpgradeRouter.js';
import type { AdmissionController } from '../admission/AdmissionController.js';
import type { PublicConnection } from '../connections/PublicConnection.js';
import { WsPublicConnection } from '../connections/WsPublicConnection.js';
import type { DifusionMetrics } from '../metrics/DifusionMetrics.js';
import { SubscriptionRequest } from '../topics/SubscriptionRequest.js';

export const PUBLIC_WS_PATH = '/ws/publico';

/**
 * Variante WebSocket del canal público (/ws/publico?topics=...&cursor=...), para medir los
 * tres transportes con el mismo servidor. Mismos tópicos, cursores y política que SSE.
 */
export class PublicWebSocketGateway {
  private readonly server = new WebSocketServer({
    noServer: true,
    // Sin compresión: con 50.000 conexiones el costo de CPU y memoria por socket no compensa
    perMessageDeflate: false,
    // El público no envía datos; se limita para que nadie lo use para inundar
    maxPayload: 1024,
  });

  constructor(
    private readonly admission: AdmissionController,
    private readonly metrics: DifusionMetrics,
    private readonly attach: (connection: PublicConnection) => void,
  ) {}

  register(upgrades: UpgradeRouter): void {
    upgrades.register(PUBLIC_WS_PATH, (request, socket, head) => this.handleUpgrade(request, socket, head));
  }

  close(): void {
    this.server.close();
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const decision = this.admission.tryAdmit();
    if (!decision.admitted) {
      this.metrics.admissionRejected();
      reject(socket, '503 Service Unavailable', `Retry-After: ${decision.retryAfterSec}\r\n`);
      return;
    }
    let subscription: SubscriptionRequest;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      subscription = SubscriptionRequest.parse({
        topics: url.searchParams.get('topics') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
      });
    } catch {
      reject(socket, '400 Bad Request');
      return;
    }
    this.server.handleUpgrade(request, socket, head, (ws) => {
      this.attach(new WsPublicConnection(ws, subscription.topics, subscription.cursors));
    });
  }
}

function reject(socket: Duplex, status: string, extraHeaders = ''): void {
  socket.write(`HTTP/1.1 ${status}\r\n${extraHeaders}Connection: close\r\n\r\n`);
  socket.destroy();
}
