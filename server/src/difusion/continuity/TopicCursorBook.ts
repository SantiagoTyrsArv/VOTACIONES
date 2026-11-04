import type { StreamId } from '@votaciones/shared';

/**
 * Último id de stream que ESTA instancia ya difundió por tópico (inicio de su próxima ventana).
 * null significa "desde el principio" (el tópico aún no tiene actas).
 */
export class TopicCursorBook {
  private readonly cursors = new Map<string, StreamId | null>();

  has(topic: string): boolean {
    return this.cursors.has(topic);
  }

  get(topic: string): StreamId | null {
    return this.cursors.get(topic) ?? null;
  }

  /** Solo inicializa: si el tópico ya tiene cursor no lo toca. */
  adopt(topic: string, cursor: StreamId | null): void {
    if (!this.cursors.has(topic)) this.cursors.set(topic, cursor);
  }

  advance(topic: string, cursor: StreamId): void {
    this.cursors.set(topic, cursor);
  }

  /** Cuando un tópico se queda sin suscriptores locales se olvida su cursor. */
  forget(topic: string): void {
    this.cursors.delete(topic);
  }
}
