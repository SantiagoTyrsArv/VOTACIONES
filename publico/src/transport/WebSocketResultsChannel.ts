import { WS_CLOSE_RECONNECT_WITH_CURSOR, type PublicEvent } from '@votaciones/shared';
import type { ResultsStore } from '../state/ResultsStore.js';
import { BaseResultsChannel } from './BaseResultsChannel.js';
import type { ChannelEvents } from './ResultsChannel.js';

/** Variante WebSocket, solo para comparar transportes (?transporte=ws). */
export class WebSocketResultsChannel extends BaseResultsChannel {
  readonly transport = 'WebSocket';
  private socket: WebSocket | null = null;

  constructor(baseUrl: string, store: ResultsStore, events: ChannelEvents) {
    super(baseUrl, store, events);
  }

  protected open(): void {
    const wsBase = this.baseUrl.replace(/^http/, 'ws') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const socket = new WebSocket(`${wsBase}/ws/publico?topics=${this.topicsParam()}&cursor=${this.cursorParam()}`);
    this.socket = socket;
    socket.onopen = () => this.connected();
    socket.onmessage = (message: MessageEvent<string>) => this.deliver(JSON.parse(message.data) as PublicEvent);
    socket.onclose = (closeEvent) => {
      if (this.socket !== socket) return;
      // 4008 = el servidor pide volver con continuidad (contrapresión). Cualquier cierre
      // reconecta igual con full jitter y los cursores actuales.
      if (closeEvent.code === WS_CLOSE_RECONNECT_WITH_CURSOR) console.info('El servidor pidió reconectar con continuidad');
      this.reconnect();
    };
  }

  protected close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
