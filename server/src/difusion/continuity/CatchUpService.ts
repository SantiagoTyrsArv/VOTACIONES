import type { PublicDelta, PublicSnapshot, SnapshotReason, StreamId } from '@votaciones/shared';
import type { DeltaCondenser } from '../aggregation/DeltaCondenser.js';
import type { ResultsSource } from './ResultsStreamReader.js';

export interface CatchUpOptions {
  /** Más entradas pendientes que esto → fotografía (más barata que reproducir el detalle). */
  readonly maxEntries: number;
  /** Ausencia más larga que esto → fotografía. */
  readonly maxAbsenceMs: number;
}

export const DEFAULT_CATCH_UP: CatchUpOptions = { maxEntries: 200, maxAbsenceMs: 5 * 60_000 };

export type CatchUpEvent = PublicDelta | PublicSnapshot;

/**
 * Decide qué entregar a un cliente que llega con un cursor (RF-6):
 *
 *   sin cursor                         → fotografía "inicial"
 *   cursor > último id del stream      → fotografía (Redis se reinició o cursor inválido)
 *   ausencia > 5 min                   → fotografía "ausencia_larga"
 *   cursor < primer id conservado      → fotografía "cursor_recortado"
 *   más de 200 entradas pendientes     → fotografía "demasiado_atras"
 *   0 entradas pendientes              → nada (ya está al día)
 *   en otro caso                       → UN delta condensado con lo que se perdió
 *
 * Un cliente que se fue 30 s recibe así un único mensaje pequeño y queda exactamente
 * igual que uno que nunca se desconectó, sin descargar todo el acumulado.
 */
export class CatchUpService {
  constructor(
    private readonly reader: ResultsSource,
    private readonly condenser: DeltaCondenser,
    private readonly instanceId: string,
    private readonly options: CatchUpOptions = DEFAULT_CATCH_UP,
  ) {}

  async resume(topic: string, cursor: StreamId | null, nowMs = Date.now()): Promise<CatchUpEvent | null> {
    if (!cursor) return this.photograph(topic, 'inicial');
    if (nowMs - cursor.timestampMs > this.options.maxAbsenceMs) return this.photograph(topic, 'ausencia_larga');

    const window = await this.reader.readWindow(topic, cursor, this.options.maxEntries + 1);
    if (!window.last || cursor.isAfter(window.last)) return this.photograph(topic, 'cursor_recortado');
    if (window.first && window.first.isAfter(cursor)) {
      // La entrada del cursor ya no existe: MAXLEN recortó el stream y pudo perderse
      // historial entre el cursor y lo que queda. Por prudencia, fotografía.
      return this.photograph(topic, 'cursor_recortado');
    }
    if (window.records.length > this.options.maxEntries) return this.photograph(topic, 'demasiado_atras');
    return this.condenser.condense(topic, cursor, window.records);
  }

  async photograph(topic: string, reason: SnapshotReason): Promise<PublicSnapshot> {
    const snapshot = await this.reader.snapshot(topic);
    return {
      type: 'snapshot',
      topic,
      to: snapshot.lastId?.toString() ?? null,
      totals: snapshot.totals,
      reason,
      instance: this.instanceId,
    };
  }
}
