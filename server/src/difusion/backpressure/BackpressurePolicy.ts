import type { PublicConnection } from '../connections/PublicConnection.js';

export interface BackpressureThresholds {
  /** Por encima de esto la conexión pasa a "atrasada" y deja de recibir deltas. */
  readonly lagBytes: number;
  /** Por debajo de esto una conexión atrasada se considera al día y recibe una puesta al día. */
  readonly resumeBytes: number;
  /** Por encima de esto se desconecta sin esperar más. */
  readonly disconnectBytes: number;
  /** Tiempo máximo atrasada antes de desconectarla. */
  readonly maxLagMs: number;
}

export const DEFAULT_BACKPRESSURE: BackpressureThresholds = {
  lagBytes: 64 * 1024,
  resumeBytes: 16 * 1024,
  disconnectBytes: 1024 * 1024,
  maxLagMs: 60_000,
};

export type SendDecision = 'enviar' | 'atrasar' | 'desconectar';
export type LagDecision = 'esperar' | 'reanudar' | 'desconectar';

/**
 * Política explícita de clientes lentos (RF-9).
 *
 *   pendiente ≤ 64 KB                 → enviar el delta
 *   64 KB < pendiente ≤ 1 MB          → "atrasada": no se encolan más deltas (el búfer deja de crecer)
 *   atrasada y pendiente ≤ 16 KB      → reanudar con UNA puesta al día (delta condensado o fotografía)
 *   pendiente > 1 MB o atrasada > 60 s → desconectar con orden "reconnect" (WS: código 4008)
 *
 * Por qué no seguir encolando: Node guarda en memoria todo lo que write() no pudo entregar.
 * Con 50.000 conexiones, unas cuantas en red 2G bastan para disparar la memoria del proceso.
 * Como cada delta lleva valores absolutos, saltarse deltas no pierde información: la
 * puesta al día posterior trae el estado correcto.
 */
export class BackpressurePolicy {
  constructor(readonly thresholds: BackpressureThresholds = DEFAULT_BACKPRESSURE) {}

  beforeSend(connection: PublicConnection): SendDecision {
    const pending = connection.pendingBytes;
    if (pending > this.thresholds.disconnectBytes) return 'desconectar';
    if (pending > this.thresholds.lagBytes) return 'atrasar';
    return 'enviar';
  }

  whileLagging(connection: PublicConnection, nowMs: number): LagDecision {
    const pending = connection.pendingBytes;
    const lagStart = connection.laggingSince ?? nowMs;
    if (pending > this.thresholds.disconnectBytes || nowMs - lagStart > this.thresholds.maxLagMs) {
      return 'desconectar';
    }
    return pending <= this.thresholds.resumeBytes ? 'reanudar' : 'esperar';
  }
}
