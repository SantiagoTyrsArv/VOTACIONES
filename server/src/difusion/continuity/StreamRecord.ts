import { parseStreamEntry, StreamId, type ResultsStreamEntry } from '@votaciones/shared';

/** Entrada de un stream de resultados ya tipada. */
export interface StreamRecord {
  id: StreamId;
  entry: ResultsStreamEntry;
}

/**
 * Normaliza la respuesta de XRANGE/XREVRANGE. node-redis entrega [{id, message}] fuera de
 * MULTI, y según la versión puede entregar la forma cruda [[id, [campo, valor, ...]]] dentro
 * de MULTI; aceptamos ambas.
 */
export function toStreamRecords(reply: unknown): StreamRecord[] {
  if (!Array.isArray(reply)) return [];
  const records: StreamRecord[] = [];
  for (const item of reply) {
    if (Array.isArray(item)) {
      const [id, flat] = item as [string, string[]];
      records.push({ id: StreamId.parse(id), entry: parseStreamEntry(pairsToObject(flat)) });
    } else if (item && typeof item === 'object' && 'id' in item) {
      const { id, message } = item as { id: string; message: Record<string, string> };
      records.push({ id: StreamId.parse(id), entry: parseStreamEntry(message) });
    }
  }
  return records;
}

/** Normaliza HGETALL (objeto o lista plana [campo, valor, ...]) a números. */
export function toNumberRecord(reply: unknown): Record<string, number> {
  const source: Record<string, string> = Array.isArray(reply)
    ? pairsToObject(reply as string[])
    : ((reply ?? {}) as Record<string, string>);
  const result: Record<string, number> = {};
  for (const [field, value] of Object.entries(source)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) result[field] = numeric;
  }
  return result;
}

function pairsToObject(flat: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!flat) return result;
  for (let i = 0; i + 1 < flat.length; i += 2) result[flat[i]!] = flat[i + 1]!;
  return result;
}
