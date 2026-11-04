import {
  CURSOR_SEPARATOR,
  CURSOR_TOPIC_SEPARATOR,
  StreamId,
  type CorrectionNotice,
  type PublicDelta,
  type PublicEvent,
  type PublicSnapshot,
  type Totals,
} from '@votaciones/shared';

export type ApplyOutcome = 'aplicado' | 'duplicado' | 'hueco' | 'ignorado';

export interface TopicView {
  topic: string;
  totals: Totals;
  cursor: StreamId | null;
  loaded: boolean;
}

export interface CorrectionEntry extends CorrectionNotice {
  topic: string;
  atMs: number;
}

/**
 * Una fotografía (tras reconexión larga o contrapresión) no trae el detalle de las actas:
 * si en ella baja algún número, es porque hubo correcciones mientras el cliente no estaba.
 * Se muestra un aviso general en lugar de dejar que el número retroceda en silencio (RF-2).
 */
export interface ReconcileNotice {
  topic: string;
  atMs: number;
  decreasedFields: string[];
}

/**
 * Estado de resultados del navegador con la regla de continuidad (RF-6):
 *   delta.to   <= cursor  → duplicado (ya lo tenía)
 *   delta.from <= cursor  → aplica los valores absolutos y avanza el cursor
 *   delta.from  > cursor  → hueco: hay que reconectar con el cursor actual
 * Una fotografía reemplaza el estado si no es más vieja que el cursor.
 *
 * Además vigila la garantía "el número nunca retrocede sin explicación": si un campo baja
 * en un mensaje que no trae corrección, lo cuenta como anomalía (debe ser siempre 0).
 */
export class ResultsStore {
  private readonly topics = new Map<string, TopicView>();
  private readonly corrections: CorrectionEntry[] = [];
  private unexplainedDecreases = 0;
  private reconcile: ReconcileNotice | null = null;
  private frozenSince: number | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(topics: readonly string[]) {
    for (const topic of topics) this.topics.set(topic, { topic, totals: {}, cursor: null, loaded: false });
  }

  apply(event: PublicEvent): ApplyOutcome {
    let outcome: ApplyOutcome = 'ignorado';
    if (event.type === 'delta') outcome = this.applyDelta(event);
    else if (event.type === 'snapshot') outcome = this.applySnapshot(event);
    else if (event.type === 'status') {
      this.frozenSince = event.frozen ? (event.sinceMs ?? Date.now()) : null;
      outcome = 'aplicado';
    }
    if (outcome === 'aplicado') this.notify();
    return outcome;
  }

  /** "dep@id,mun:11@id": lo que se envía al reconectar para retomar donde quedó. */
  cursorParam(): string {
    const parts: string[] = [];
    for (const view of this.topics.values()) {
      if (view.cursor) parts.push(`${view.topic}${CURSOR_TOPIC_SEPARATOR}${view.cursor.toString()}`);
    }
    return parts.join(CURSOR_SEPARATOR);
  }

  view(topic: string): TopicView | undefined {
    return this.topics.get(topic);
  }

  get topicNames(): string[] {
    return [...this.topics.keys()];
  }

  get recentCorrections(): readonly CorrectionEntry[] {
    return this.corrections;
  }

  get lastReconcile(): ReconcileNotice | null {
    return this.reconcile;
  }

  get anomalies(): number {
    return this.unexplainedDecreases;
  }

  get frozenSinceMs(): number | null {
    return this.frozenSince;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private applyDelta(event: PublicDelta): ApplyOutcome {
    const view = this.topics.get(event.topic);
    if (!view) return 'ignorado';
    const to = StreamId.parse(event.to);
    const from = StreamId.tryParse(event.from);
    if (view.cursor && to.isAtOrBefore(view.cursor)) return 'duplicado';
    const fromCovered = from === null || (view.cursor !== null && from.isAtOrBefore(view.cursor));
    if (!view.loaded || !fromCovered) return 'hueco';

    const corrected = event.corrections.length > 0;
    for (const [field, value] of Object.entries(event.changes)) {
      const previous = view.totals[field];
      if (previous !== undefined && value < previous && !corrected) this.unexplainedDecreases++;
      view.totals[field] = value;
    }
    for (const correction of event.corrections) {
      this.corrections.unshift({ ...correction, topic: event.topic, atMs: Date.now() });
    }
    this.corrections.length = Math.min(this.corrections.length, 20);
    view.cursor = to;
    return 'aplicado';
  }

  private applySnapshot(event: PublicSnapshot): ApplyOutcome {
    const view = this.topics.get(event.topic);
    if (!view) return 'ignorado';
    const to = StreamId.tryParse(event.to);
    if (view.cursor && to && to.isAtOrBefore(view.cursor) && view.loaded) return 'duplicado';
    if (view.loaded) {
      const decreased = Object.keys(view.totals).filter((field) => (event.totals[field] ?? 0) < view.totals[field]!);
      if (decreased.length > 0) this.reconcile = { topic: event.topic, atMs: Date.now(), decreasedFields: decreased };
    }
    view.totals = { ...event.totals };
    view.cursor = to ?? view.cursor;
    view.loaded = true;
    return 'aplicado';
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
