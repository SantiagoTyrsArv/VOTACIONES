import type { PublicEvent } from '@votaciones/shared';
import type { ApplyOutcome } from '../state/ResultsStore.js';

export type ConnectionPhase = 'conectando' | 'conectado' | 'reconectando';

export interface ChannelStatus {
  phase: ConnectionPhase;
  transport: string;
  instance: string | null;
  reconnects: number;
  nextRetryMs: number | null;
}

export interface ChannelEvents {
  /** Aplica el evento al estado y devuelve el resultado (para detectar huecos). */
  onEvent(event: PublicEvent, receivedAtMs: number): ApplyOutcome;
  onStatus(status: ChannelStatus): void;
}

/** Canal de resultados: SSE, WebSocket o polling, intercambiables. */
export interface ResultsChannel {
  readonly transport: string;
  start(): void;
  stop(): void;
}
