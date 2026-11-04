import type { PublicEvent } from '@votaciones/shared';
import type { ResultsStore } from '../state/ResultsStore.js';
import { BaseResultsChannel } from './BaseResultsChannel.js';
import type { ChannelEvents } from './ResultsChannel.js';

interface PollResponse {
  instance: string;
  events: PublicEvent[];
}

/**
 * Polling cada 2 s (?transporte=poll): línea base de comparación y respaldo si un proxy
 * bloquea SSE. Cada consulta envía los cursores y recibe solo lo nuevo.
 */
export class PollingResultsChannel extends BaseResultsChannel {
  readonly transport = 'Polling 2 s';
  private timer: number | null = null;
  private active = false;

  constructor(
    baseUrl: string,
    store: ResultsStore,
    events: ChannelEvents,
    private readonly intervalMs = 2_000,
  ) {
    super(baseUrl, store, events);
  }

  protected open(): void {
    this.active = true;
    void this.poll(true);
  }

  protected close(): void {
    this.active = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(first: boolean): Promise<void> {
    if (!this.active) return;
    try {
      const response = await fetch(`${this.baseUrl}/publico/poll?topics=${this.topicsParam()}&cursor=${this.cursorParam()}`, {
        cache: 'no-store',
      });
      const body = (await response.json()) as PollResponse;
      if (first || response.ok) this.connected();
      for (const event of body.events) this.deliver(event);
      if (!response.ok && response.status !== 503) throw new Error(`HTTP ${response.status}`);
    } catch {
      this.reconnect();
      return;
    }
    if (this.active) this.timer = window.setTimeout(() => void this.poll(false), this.intervalMs);
  }
}
