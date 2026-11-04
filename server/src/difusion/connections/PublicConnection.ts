import type { StreamId } from '@votaciones/shared';
import type { EncodedMessage } from './EncodedMessage.js';

export type PublicTransport = 'sse' | 'ws';

/** Estado de sincronización de la conexión con los streams de sus tópicos. */
export type SyncState =
  /** Aún no recibió su ponerse-al-día: el fan-out la salta para no crear huecos. */
  | 'sincronizando'
  /** Recibe los deltas de cada ventana. */
  | 'al_dia'
  /** Contrapresión: su búfer creció demasiado y se le dejaron de enviar deltas (RF-9). */
  | 'atrasada';

let nextConnectionId = 1;

/**
 * Conexión de un cliente público, independiente del transporte (SSE o WebSocket).
 * Guarda los tópicos a los que está suscrita y el cursor (último id de stream recibido)
 * de cada uno: con eso se reanuda tras contrapresión o caída de Redis.
 */
export abstract class PublicConnection {
  readonly id = nextConnectionId++;
  readonly openedAtMs = Date.now();
  private readonly cursors = new Map<string, StreamId | null>();
  private state: SyncState = 'sincronizando';
  private laggingSinceMs: number | null = null;
  private closed = false;
  private readonly closeListeners: Array<() => void> = [];

  protected constructor(
    readonly transport: PublicTransport,
    topics: Iterable<string>,
    initialCursors: ReadonlyMap<string, StreamId>,
  ) {
    for (const topic of topics) this.cursors.set(topic, initialCursors.get(topic) ?? null);
  }

  /** Bytes escritos que el sistema operativo todavía no ha logrado enviar al cliente. */
  abstract get pendingBytes(): number;

  /** Escribe el mensaje en el transporte. No decide políticas: eso lo hace quien llama. */
  protected abstract write(message: EncodedMessage): void;

  /** Cierra el transporte pidiendo al cliente que vuelva con sus cursores. */
  protected abstract terminate(reason: string, retryAfterMs: number): void;

  /** Latido de mantenimiento (comentario SSE o ping WebSocket). */
  abstract heartbeat(): void;

  get topics(): IterableIterator<string> {
    return this.cursors.keys();
  }

  get syncState(): SyncState {
    return this.state;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  get laggingSince(): number | null {
    return this.laggingSinceMs;
  }

  cursorOf(topic: string): StreamId | null {
    return this.cursors.get(topic) ?? null;
  }

  /** Envía y avanza el cursor del tópico si el mensaje lo trae. */
  send(message: EncodedMessage): void {
    if (this.closed) return;
    this.write(message);
    const target = message.cursorTarget;
    if (target && this.cursors.has(target.topic)) {
      const current = this.cursors.get(target.topic);
      if (!current || target.to.isAfter(current)) this.cursors.set(target.topic, target.to);
    }
  }

  markSynchronizing(): void {
    this.state = 'sincronizando';
  }

  markUpToDate(): void {
    this.state = 'al_dia';
    this.laggingSinceMs = null;
  }

  markLagging(nowMs: number): void {
    if (this.state !== 'atrasada') this.laggingSinceMs = nowMs;
    this.state = 'atrasada';
  }

  close(reason: string, retryAfterMs = 0): void {
    if (this.closed) return;
    this.terminate(reason, retryAfterMs);
    this.handleClosed();
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** Lo invocan las subclases cuando el transporte se cierra por cualquier motivo. */
  protected handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}
