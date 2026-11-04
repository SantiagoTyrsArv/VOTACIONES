import { StreamId, type ResultsStreamEntry, type Totals } from '@votaciones/shared';
import type { StreamRecord } from '../../src/difusion/continuity/StreamRecord.js';
import type {
  ResultsSource,
  StreamWindow,
  TopicSnapshot,
} from '../../src/difusion/continuity/ResultsStreamReader.js';

/**
 * Imitación en memoria de lo que escribe aplicar_acta.lua: un stream y un hash por tópico.
 * Permite probar la continuidad sin un Redis real.
 */
export class InMemoryResults implements ResultsSource {
  private readonly streams = new Map<string, StreamRecord[]>();
  private readonly totals = new Map<string, Totals>();
  private clock: number;

  /** @param startMs marca de tiempo del primer id de stream (como los ids reales de Redis). */
  constructor(startMs = 1_000) {
    this.clock = startMs;
  }

  /** Aplica un acta con el delta dado al tópico y devuelve el id de la entrada. */
  apply(topic: string, acta: string, delta: Totals, options: Partial<ResultsStreamEntry> = {}): StreamId {
    const current = { ...(this.totals.get(topic) ?? {}) };
    for (const [field, change] of Object.entries(delta)) current[field] = (current[field] ?? 0) + change;
    this.totals.set(topic, current);
    const id = StreamId.parse(`${this.clock++}-0`);
    const entry: ResultsStreamEntry = {
      acta,
      version: 1,
      previousVersion: 0,
      reason: 'nueva',
      delta,
      totals: { ...current },
      receivedAtMs: id.timestampMs - 1,
      ...options,
    };
    const stream = this.streams.get(topic) ?? [];
    stream.push({ id, entry });
    this.streams.set(topic, stream);
    return id;
  }

  /** Simula XTRIM MAXLEN: conserva solo las últimas "keep" entradas. */
  trim(topic: string, keep: number): void {
    const stream = this.streams.get(topic) ?? [];
    this.streams.set(topic, stream.slice(-keep));
  }

  totalsOf(topic: string): Totals {
    return { ...(this.totals.get(topic) ?? {}) };
  }

  async readAfter(topic: string, after: StreamId | null, count: number): Promise<StreamRecord[]> {
    return (this.streams.get(topic) ?? []).filter((r) => !after || r.id.isAfter(after)).slice(0, count);
  }

  async readWindow(topic: string, after: StreamId | null, count: number): Promise<StreamWindow> {
    const stream = this.streams.get(topic) ?? [];
    return {
      first: stream[0]?.id ?? null,
      last: stream.at(-1)?.id ?? null,
      records: await this.readAfter(topic, after, count),
    };
  }

  async snapshot(topic: string): Promise<TopicSnapshot> {
    return { totals: this.totalsOf(topic), lastId: this.streams.get(topic)?.at(-1)?.id ?? null };
  }
}
