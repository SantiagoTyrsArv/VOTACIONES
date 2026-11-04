import type { CorrectionNotice, PublicDelta, StreamId, Totals } from '@votaciones/shared';
import type { StreamRecord } from '../continuity/StreamRecord.js';

/**
 * Condensa N entradas de stream (N actas de una ventana) en UN solo mensaje (RF-4).
 *
 * El mensaje lleva, para cada campo tocado en la ventana, su valor ABSOLUTO al final.
 * Por qué absolutos y no sumas:
 *  - aplicar dos veces el mismo mensaje no duplica votos (idempotente);
 *  - un cliente que ya tenía parte de la ventana (puesta al día reciente) converge igual;
 *  - saltarse deltas por contrapresión no corrompe el estado.
 * Se incluyen TODOS los campos tocados, incluso si su cambio neto es cero (+5 y luego −5
 * por una corrección), porque un cliente a mitad de la ventana puede tener el valor intermedio.
 */
export class DeltaCondenser {
  constructor(private readonly instanceId: string) {}

  condense(topic: string, from: StreamId | null, records: readonly StreamRecord[]): PublicDelta | null {
    const last = records.at(-1);
    if (!last) return null;

    const touched = new Set<string>();
    const corrections: CorrectionNotice[] = [];
    let oldestReceivedAtMs = Number.POSITIVE_INFINITY;

    for (const { id, entry } of records) {
      for (const field of Object.keys(entry.delta)) touched.add(field);
      if (entry.reason !== 'nueva') {
        corrections.push({ acta: entry.acta, fromVersion: entry.previousVersion, toVersion: entry.version, reason: entry.reason });
      }
      const receivedAt = entry.receivedAtMs > 0 ? entry.receivedAtMs : id.timestampMs;
      oldestReceivedAtMs = Math.min(oldestReceivedAtMs, receivedAt);
    }

    return {
      type: 'delta',
      topic,
      from: from?.toString() ?? null,
      to: last.id.toString(),
      changes: this.absoluteValues(touched, records),
      actas: records.length,
      corrections,
      oldestReceivedAtMs,
      instance: this.instanceId,
    };
  }

  /** Valor final de cada campo: el de la entrada más reciente que lo reporte en sus totales. */
  private absoluteValues(fields: Set<string>, records: readonly StreamRecord[]): Totals {
    const changes: Totals = {};
    for (const field of fields) {
      for (let i = records.length - 1; i >= 0; i--) {
        const value = records[i]!.entry.totals[field];
        if (value !== undefined) {
          changes[field] = value;
          break;
        }
      }
    }
    return changes;
  }
}
