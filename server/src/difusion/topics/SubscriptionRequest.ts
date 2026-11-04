import { CURSOR_SEPARATOR, CURSOR_TOPIC_SEPARATOR, StreamId, Topic } from '@votaciones/shared';

/** Máximo de tópicos por conexión: departamento + un municipio o puesto. */
export const MAX_TOPICS_PER_CONNECTION = 2;

export class InvalidSubscriptionError extends Error {}

/**
 * Lo que un cliente pide al conectarse: tópicos y, si viene de una reconexión,
 * el último id de stream que recibió en cada uno (RF-6).
 *
 * Fuentes de cursores, de menor a mayor prioridad:
 *  1. Cabecera Last-Event-ID nativa del navegador ("tópico@id", un solo tópico).
 *  2. Parámetro ?cursor=dep@id,mun:11@id que envía nuestro cliente con TODOS sus tópicos.
 */
export class SubscriptionRequest {
  private constructor(
    readonly topics: readonly string[],
    readonly cursors: ReadonlyMap<string, StreamId>,
  ) {}

  static parse(params: {
    topics?: string | undefined;
    cursor?: string | undefined;
    lastEventId?: string | undefined;
  }): SubscriptionRequest {
    const topics = SubscriptionRequest.parseTopics(params.topics ?? 'dep');
    const cursors = new Map<string, StreamId>();
    for (const raw of [params.lastEventId, params.cursor]) {
      for (const [topic, id] of SubscriptionRequest.parseCursors(raw)) {
        if (topics.includes(topic)) cursors.set(topic, id);
      }
    }
    return new SubscriptionRequest(topics, cursors);
  }

  private static parseTopics(raw: string): string[] {
    const topics = [
      ...new Set(
        raw
          .split(CURSOR_SEPARATOR)
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ];
    if (topics.length === 0) throw new InvalidSubscriptionError('Debe indicar al menos un tópico');
    if (topics.length > MAX_TOPICS_PER_CONNECTION) {
      throw new InvalidSubscriptionError(`Máximo ${MAX_TOPICS_PER_CONNECTION} tópicos por conexión`);
    }
    return topics.map((text) => {
      const topic = Topic.tryParse(text);
      if (!topic) throw new InvalidSubscriptionError(`Tópico inválido: ${text}`);
      return topic.toString();
    });
  }

  /** Cursores mal formados se ignoran: el cliente simplemente recibe una fotografía. */
  private static parseCursors(raw: string | undefined): Array<[string, StreamId]> {
    if (!raw) return [];
    const result: Array<[string, StreamId]> = [];
    for (const part of raw.split(CURSOR_SEPARATOR)) {
      const at = part.lastIndexOf(CURSOR_TOPIC_SEPARATOR);
      if (at <= 0) continue;
      const topic = Topic.tryParse(part.slice(0, at));
      const id = StreamId.tryParse(part.slice(at + 1));
      if (topic && id) result.push([topic.toString(), id]);
    }
    return result;
  }
}
