import { ReconnectBackoff, type PublicEvent } from '@votaciones/shared';
import type { ResultsStore } from '../state/ResultsStore.js';
import type { ChannelEvents, ChannelStatus, ConnectionPhase, ResultsChannel } from './ResultsChannel.js';

/**
 * Comportamiento común de los canales: reconexión con full jitter, reporte de estado y
 * resincronización cuando se detecta un hueco en la continuidad.
 */
export abstract class BaseResultsChannel implements ResultsChannel {
  abstract readonly transport: string;

  protected readonly backoff = new ReconnectBackoff();
  private retryTimer: number | null = null;
  private stopped = false;
  private status: ChannelStatus;

  protected constructor(
    protected readonly baseUrl: string,
    protected readonly store: ResultsStore,
    protected readonly events: ChannelEvents,
  ) {
    this.status = { phase: 'conectando', transport: '', instance: null, reconnects: 0, nextRetryMs: null };
  }

  /** Abre el transporte usando los cursores actuales del estado. */
  protected abstract open(): void;
  /** Cierra el transporte sin programar reintentos. */
  protected abstract close(): void;

  start(): void {
    this.stopped = false;
    this.setPhase('conectando');
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.close();
  }

  protected topicsParam(): string {
    return encodeURIComponent(this.store.topicNames.join(','));
  }

  protected cursorParam(): string {
    return encodeURIComponent(this.store.cursorParam());
  }

  protected connected(): void {
    this.backoff.reset();
    this.setPhase('conectado');
  }

  /** Entrega un evento; si revela un hueco, reconecta de inmediato con los cursores. */
  protected deliver(event: PublicEvent): void {
    if ('instance' in event && event.instance) this.status.instance = event.instance;
    if (event.type === 'reconnect') {
      this.reconnect(event.retryAfterMs);
      return;
    }
    const outcome = this.events.onEvent(event, Date.now());
    if (outcome === 'hueco') this.reconnect(0);
  }

  /** Cierra y vuelve a abrir tras una espera con full jitter (o la mínima indicada). */
  protected reconnect(minimumMs = 0): void {
    this.close();
    if (this.stopped) return;
    const delay = this.backoff.nextDelayAtLeast(minimumMs);
    this.status.reconnects++;
    this.status.nextRetryMs = delay;
    this.setPhase('reconectando');
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.status.nextRetryMs = null;
      this.setPhase('conectando');
      this.open();
    }, delay);
  }

  private setPhase(phase: ConnectionPhase): void {
    this.status = { ...this.status, phase, transport: this.transport };
    this.events.onStatus(this.status);
  }
}
