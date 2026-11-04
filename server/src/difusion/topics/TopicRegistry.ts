/** Lo mínimo que el registro necesita saber de una conexión. */
export interface TopicSubscriber {
  readonly id: number;
  readonly topics: Iterable<string>;
}

/**
 * Relación tópico ↔ conexiones de ESTA instancia (RF-5).
 *
 * Estructura: Map<tópico, Set<conexión>>. La conexión ya conoce sus propios tópicos
 * (máximo 2: departamento + un municipio o puesto), así que no hace falta un índice inverso.
 *
 * Costos:
 *  - alta:     O(k) con k = tópicos de la conexión (k ≤ 2) → O(1)
 *  - baja:     O(k) → O(1); Set.delete es O(1)
 *  - recorrido de un tópico: O(suscriptores del tópico), independiente de las
 *    ~50.000 conexiones totales de la instancia.
 */
export class TopicRegistry<C extends TopicSubscriber> {
  private readonly byTopic = new Map<string, Set<C>>();
  private readonly connections = new Set<C>();

  add(connection: C): void {
    this.connections.add(connection);
    for (const topic of connection.topics) {
      let subscribers = this.byTopic.get(topic);
      if (!subscribers) {
        subscribers = new Set();
        this.byTopic.set(topic, subscribers);
      }
      subscribers.add(connection);
    }
  }

  /** @returns los tópicos que se quedaron sin suscriptores locales. */
  remove(connection: C): string[] {
    if (!this.connections.delete(connection)) return [];
    const emptied: string[] = [];
    for (const topic of connection.topics) {
      const subscribers = this.byTopic.get(topic);
      if (!subscribers) continue;
      subscribers.delete(connection);
      if (subscribers.size === 0) {
        this.byTopic.delete(topic);
        emptied.push(topic);
      }
    }
    return emptied;
  }

  /**
   * Iterador vivo sobre los suscriptores. Iterar un Set mientras otras conexiones se
   * cierran es seguro en JavaScript (las borradas no se visitan) y evita copiar 50.000
   * referencias en cada ventana.
   */
  subscribersOf(topic: string): Iterable<C> {
    return this.byTopic.get(topic) ?? EMPTY;
  }

  subscriberCount(topic: string): number {
    return this.byTopic.get(topic)?.size ?? 0;
  }

  hasSubscribers(topic: string): boolean {
    return this.byTopic.has(topic);
  }

  get activeTopics(): IterableIterator<string> {
    return this.byTopic.keys();
  }

  get all(): Iterable<C> {
    return this.connections;
  }

  get size(): number {
    return this.connections.size;
  }

  get topicCount(): number {
    return this.byTopic.size;
  }
}

const EMPTY: ReadonlySet<never> = new Set<never>();
