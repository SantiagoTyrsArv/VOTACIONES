/**
 * Contrato entre la ingesta (A, escribe) y la difusión (B, lee).
 */

/** Campos fijos de los hashes de acumulados tot:{tópico}, además de un campo por candidato. */
export const TotalsField = {
  voters: 'sufragantes',
  reportedTables: 'mesas_inf',
  totalTables: 'mesas_tot',
} as const;

export type Totals = Record<string, number>;

export type ChangeReason = 'nueva' | 'correccion' | 'retiro_dudosa' | 'verificacion';

/**
 * Campos de cada entrada XADD en st:{tópico}. Redis guarda strings planos,
 * por eso delta y totals viajan como JSON.
 */
export interface ResultsStreamEntry {
  acta: string;
  version: number;
  previousVersion: number;
  reason: ChangeReason;
  /** Cambio que esta acta produjo en el acumulado del tópico (incluye mesas_inf). */
  delta: Totals;
  /** Acumulado completo del tópico DESPUÉS de aplicar el acta. */
  totals: Totals;
  /** Momento (ms) en que la instancia recibió el acta; mide latencia acta→público. */
  receivedAtMs: number;
}

/** Nombres de campo en Redis para ResultsStreamEntry (los escribe aplicar_acta.lua). */
export const StreamEntryField = {
  acta: 'acta',
  version: 'version',
  previousVersion: 'version_anterior',
  reason: 'motivo',
  delta: 'delta',
  totals: 'totales',
  receivedAtMs: 'recibida_ms',
} as const;

/** Aviso compacto publicado en ch:actas. Solo dice "hay algo nuevo en estos tópicos". */
export interface ActaNotice {
  acta: string;
  /** Tópicos tocados, p. ej. ["dep", "mun:11", "pue:176"] */
  topics: string[];
  /** Id de la entrada escrita en cada stream, por tópico */
  streamIds: Record<string, string>;
}

/** Convierte los campos crudos de una entrada XRANGE en un objeto tipado. */
export function parseStreamEntry(fields: Record<string, string>): ResultsStreamEntry {
  return {
    acta: fields[StreamEntryField.acta] ?? '',
    version: Number(fields[StreamEntryField.version] ?? 0),
    previousVersion: Number(fields[StreamEntryField.previousVersion] ?? 0),
    reason: parseReason(fields[StreamEntryField.reason]),
    delta: safeJson(fields[StreamEntryField.delta]),
    totals: safeJson(fields[StreamEntryField.totals]),
    receivedAtMs: Number(fields[StreamEntryField.receivedAtMs] ?? 0),
  };
}

function parseReason(raw: string | undefined): ChangeReason {
  if (raw === 'correccion' || raw === 'retiro_dudosa' || raw === 'verificacion') return raw;
  return 'nueva';
}

/** Inverso de parseStreamEntry; lo usan el script de A (vía la app) y los generadores de prueba. */
export function serializeStreamEntry(entry: ResultsStreamEntry): Record<string, string> {
  return {
    [StreamEntryField.acta]: entry.acta,
    [StreamEntryField.version]: String(entry.version),
    [StreamEntryField.previousVersion]: String(entry.previousVersion),
    [StreamEntryField.reason]: entry.reason,
    [StreamEntryField.delta]: JSON.stringify(entry.delta),
    [StreamEntryField.totals]: JSON.stringify(entry.totals),
    [StreamEntryField.receivedAtMs]: String(entry.receivedAtMs),
  };
}

function safeJson(raw: string | undefined): Totals {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Totals) : {};
  } catch {
    return {};
  }
}
