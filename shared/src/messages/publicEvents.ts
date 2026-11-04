/**
 * Eventos que recibe el público (dueño: Persona B).
 * Viajan iguales por SSE, WebSocket y polling: solo cambia el sobre.
 */
import type { Totals } from './broadcast.js';

/** Nombre de evento SSE / campo "type" en WebSocket y polling. */
export const PublicEventType = {
  Delta: 'delta',
  Snapshot: 'snapshot',
  Status: 'status',
  Reconnect: 'reconnect',
} as const;

export type PublicEventType = (typeof PublicEventType)[keyof typeof PublicEventType];

export interface CorrectionNotice {
  reason: 'correccion' | 'retiro_dudosa' | 'verificacion';
  acta: string;
  fromVersion: number;
  toVersion: number;
}

/**
 * Cambio condensado de una ventana de agregación.
 * Regla del cliente (continuidad):
 *  - to <= cursor      → duplicado, se ignora.
 *  - from <= cursor    → aplica "changes" (valores ABSOLUTOS) y cursor = to.
 *  - from  > cursor    → hueco: pide reanudar con su cursor.
 */
export interface PublicDelta {
  type: typeof PublicEventType.Delta;
  topic: string;
  /** Id de stream desde el cual (exclusivo) se condensó; null = desde el inicio */
  from: string | null;
  /** Id de la última entrada incluida */
  to: string;
  /** Solo los campos que cambiaron, con su valor absoluto al final de la ventana */
  changes: Totals;
  /** Número de actas condensadas en este mensaje */
  actas: number;
  corrections: CorrectionNotice[];
  /** Recepción (ms) del acta más antigua de la ventana: latencia acta→pantalla */
  oldestReceivedAtMs: number;
  instance: string;
}

export type SnapshotReason = 'inicial' | 'cursor_recortado' | 'demasiado_atras' | 'ausencia_larga' | 'contrapresion';

/** Fotografía completa del tópico, coherente con su id de stream. */
export interface PublicSnapshot {
  type: typeof PublicEventType.Snapshot;
  topic: string;
  to: string | null;
  totals: Totals;
  reason: SnapshotReason;
  instance: string;
}

/** Estado degradado (RF-10): Redis no responde y los números están congelados. */
export interface PublicStatus {
  type: typeof PublicEventType.Status;
  frozen: boolean;
  sinceMs: number | null;
  instance: string;
}

/** Orden de reconexión (RF-9 contrapresión, cierre controlado). */
export interface PublicReconnect {
  type: typeof PublicEventType.Reconnect;
  reason: string;
  retryAfterMs: number;
}

export type PublicEvent = PublicDelta | PublicSnapshot | PublicStatus | PublicReconnect;

/** Código de cierre WebSocket "vuelve con continuidad". */
export const WS_CLOSE_RECONNECT_WITH_CURSOR = 4008;

/**
 * Cursores por tópico que el cliente envía al reconectar:
 * "dep@1793577612345-0,mun:11@1793577611002-0"
 */
export const CURSOR_SEPARATOR = ',';
export const CURSOR_TOPIC_SEPARATOR = '@';
