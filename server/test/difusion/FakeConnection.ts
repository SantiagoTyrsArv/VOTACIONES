import type { StreamId } from '@votaciones/shared';
import type { EncodedMessage } from '../../src/difusion/connections/EncodedMessage.js';
import { PublicConnection } from '../../src/difusion/connections/PublicConnection.js';

/** Conexión en memoria para pruebas: guarda lo enviado y simula bytes pendientes. */
export class FakeConnection extends PublicConnection {
  readonly received: EncodedMessage[] = [];
  pending = 0;
  closedWith: { reason: string; retryAfterMs: number } | null = null;
  heartbeats = 0;

  constructor(topics: string[], cursors: ReadonlyMap<string, StreamId> = new Map()) {
    super('sse', topics, cursors);
  }

  get pendingBytes(): number {
    return this.pending;
  }

  protected write(message: EncodedMessage): void {
    this.received.push(message);
  }

  heartbeat(): void {
    this.heartbeats++;
  }

  protected terminate(reason: string, retryAfterMs: number): void {
    this.closedWith = { reason, retryAfterMs };
  }

  /** Simula que el cliente cerró la pestaña. */
  disconnect(): void {
    this.handleClosed();
  }
}
