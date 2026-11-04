import { PublicEventType, type PublicEvent } from '@votaciones/shared';
import type { ResultsStore } from '../state/ResultsStore.js';
import { BaseResultsChannel } from './BaseResultsChannel.js';
import type { ChannelEvents } from './ResultsChannel.js';

/**
 * Transporte elegido para el público: Server-Sent Events.
 *
 * La reconexión automática de EventSource usa un "retry" fijo, igual para todos los
 * clientes: justo lo que provoca la avalancha. Por eso, ante cualquier error se cierra el
 * EventSource y se reconecta a mano con full jitter, enviando TODOS los cursores en ?cursor=
 * (Last-Event-ID solo llevaría el del último tópico recibido).
 */
export class SseResultsChannel extends BaseResultsChannel {
  readonly transport = 'SSE';
  private source: EventSource | null = null;
  private rotationTimer: number | null = null;

  /**
   * Railway corta las respuestas HTTP a los 15 min. Antes de eso el cliente rota la conexión
   * por su cuenta, en un instante aleatorio entre 12 y 14 min (escalonado: no todos a la vez),
   * y retoma con sus cursores sin perder nada.
   */
  static readonly ROTATION_MIN_MS = 12 * 60_000;
  static readonly ROTATION_MAX_MS = 14 * 60_000;

  constructor(baseUrl: string, store: ResultsStore, events: ChannelEvents) {
    super(baseUrl, store, events);
  }

  protected open(): void {
    const url = `${this.baseUrl}/publico/sse?topics=${this.topicsParam()}&cursor=${this.cursorParam()}`;
    const source = new EventSource(url);
    this.source = source;
    source.onopen = () => {
      this.connected();
      this.scheduleRotation();
    };
    source.onerror = () => this.reconnect();
    for (const type of Object.values(PublicEventType)) {
      source.addEventListener(type, (message) => {
        this.deliver(JSON.parse((message as MessageEvent<string>).data) as PublicEvent);
      });
    }
  }

  protected close(): void {
    if (this.rotationTimer !== null) clearTimeout(this.rotationTimer);
    this.rotationTimer = null;
    this.source?.close();
    this.source = null;
  }

  private scheduleRotation(): void {
    if (this.rotationTimer !== null) clearTimeout(this.rotationTimer);
    const { ROTATION_MIN_MS: min, ROTATION_MAX_MS: max } = SseResultsChannel;
    this.rotationTimer = window.setTimeout(() => {
      this.rotationTimer = null;
      this.reconnect();
    }, min + Math.random() * (max - min));
  }
}
