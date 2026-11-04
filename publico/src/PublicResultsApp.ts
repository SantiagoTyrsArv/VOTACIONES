import { Topic, type PublicEvent } from '@votaciones/shared';
import { InpReporter } from './metrics/InpReporter.js';
import { ResultsStore, type ApplyOutcome } from './state/ResultsStore.js';
import { PollingResultsChannel } from './transport/PollingResultsChannel.js';
import type { ChannelEvents, ResultsChannel } from './transport/ResultsChannel.js';
import { SseResultsChannel } from './transport/SseResultsChannel.js';
import { WebSocketResultsChannel } from './transport/WebSocketResultsChannel.js';
import { ResultsView, type LiveMetrics } from './ui/ResultsView.js';

export type TransportChoice = 'sse' | 'ws' | 'poll';

/**
 * Composición de la página: estado + canal + vista + métricas.
 * Parámetros de URL: ?mun=11 | ?pue=176 (tópico a mirar) y ?transporte=sse|ws|poll.
 */
export class PublicResultsApp {
  private channel: ResultsChannel | null = null;
  private readonly metrics: LiveMetrics = { lastLatencyMs: null, messages: 0, inpMs: null, inpRating: null };

  constructor(
    private readonly root: HTMLElement,
    private readonly baseUrl = '',
  ) {}

  start(params: URLSearchParams): void {
    const mainTopic = PublicResultsApp.topicFrom(params);
    const topics = mainTopic === 'dep' ? ['dep'] : ['dep', mainTopic];
    const store = new ResultsStore(topics);
    const view = new ResultsView(this.root, store, mainTopic, this.metrics);
    this.fillTopicForm(params);
    this.root.querySelector<HTMLElement>('[data-titulo]')!.textContent = PublicResultsApp.title(mainTopic);

    const events: ChannelEvents = {
      onEvent: (event, receivedAtMs) => this.onEvent(store, view, event, receivedAtMs),
      onStatus: (status) => view.updateStatus(status),
    };
    this.channel = PublicResultsApp.createChannel(params.get('transporte') as TransportChoice, this.baseUrl, store, events);
    this.channel.start();

    new InpReporter(`${this.baseUrl}/publico/inp`, (value, rating) => {
      this.metrics.inpMs = value;
      this.metrics.inpRating = rating;
      view.schedule();
    }).start();
    view.schedule();
  }

  private onEvent(store: ResultsStore, view: ResultsView, event: PublicEvent, receivedAtMs: number): ApplyOutcome {
    this.metrics.messages++;
    if (event.type === 'delta') this.metrics.lastLatencyMs = Math.max(0, receivedAtMs - event.oldestReceivedAtMs);
    const outcome = store.apply(event);
    view.schedule();
    return outcome;
  }

  private static createChannel(choice: TransportChoice | null, baseUrl: string, store: ResultsStore, events: ChannelEvents): ResultsChannel {
    switch (choice) {
      case 'ws':
        return new WebSocketResultsChannel(baseUrl, store, events);
      case 'poll':
        return new PollingResultsChannel(baseUrl, store, events);
      default:
        return new SseResultsChannel(baseUrl, store, events);
    }
  }

  private static topicFrom(params: URLSearchParams): string {
    const pue = Number(params.get('pue'));
    if (params.get('pue') && Number.isInteger(pue) && pue >= 0) return Topic.pollingStation(pue).toString();
    const mun = Number(params.get('mun'));
    if (params.get('mun') && Number.isInteger(mun) && mun >= 0) return Topic.municipality(mun).toString();
    return Topic.DEPARTMENT.toString();
  }

  private static title(topic: string): string {
    const parsed = Topic.parse(topic);
    if (parsed.level === 'mun') return `Municipio ${parsed.entityId}`;
    if (parsed.level === 'pue') return `Puesto de votación ${parsed.entityId}`;
    return 'Departamento';
  }

  private fillTopicForm(params: URLSearchParams): void {
    const form = this.root.querySelector<HTMLFormElement>('[data-form-topico]');
    if (!form) return;
    for (const name of ['mun', 'pue', 'transporte']) {
      const input = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (input && params.get(name)) input.value = params.get(name)!;
    }
  }
}
