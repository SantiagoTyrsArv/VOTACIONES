import { CURSOR_TOPIC_SEPARATOR, StreamId, type PublicEvent } from '@votaciones/shared';

/**
 * Evento ya serializado. Se construye UNA vez por tópico y ventana y el mismo Buffer
 * se reutiliza para todas las conexiones (serializar 50.000 veces sería el cuello de botella).
 * Las dos codificaciones se calculan de forma perezosa: solo si algún transporte las usa.
 */
export class EncodedMessage {
  private sse: Buffer | null = null;
  private json: string | null = null;
  private target: { topic: string; to: StreamId } | null | undefined = undefined;

  constructor(readonly event: PublicEvent) {}

  /** Id SSE "tópico@idDeStream"; solo los eventos que mueven un cursor lo llevan. */
  get sseId(): string | null {
    const event = this.event;
    if ((event.type === 'delta' || event.type === 'snapshot') && event.to) {
      return `${event.topic}${CURSOR_TOPIC_SEPARATOR}${event.to}`;
    }
    return null;
  }

  /**
   * Tópico y posición final, para actualizar el cursor de la conexión al enviar.
   * Se parsea una sola vez por mensaje, no una vez por conexión.
   */
  get cursorTarget(): { topic: string; to: StreamId } | null {
    if (this.target === undefined) {
      const event = this.event;
      const hasCursor = (event.type === 'delta' || event.type === 'snapshot') && event.to;
      this.target = hasCursor ? { topic: event.topic, to: StreamId.parse(event.to!) } : null;
    }
    return this.target;
  }

  get asJson(): string {
    this.json ??= JSON.stringify(this.event);
    return this.json;
  }

  /** Trama text/event-stream completa. */
  get asSseFrame(): Buffer {
    if (!this.sse) {
      const id = this.sseId;
      const lines = [id ? `id: ${id}` : null, `event: ${this.event.type}`, `data: ${this.asJson}`, '', ''];
      this.sse = Buffer.from(lines.filter((line) => line !== null).join('\n'), 'utf8');
    }
    return this.sse;
  }

  /** Bytes aproximados de este mensaje (para la métrica de bytes por actualización). */
  get byteLength(): number {
    return Buffer.byteLength(this.asJson, 'utf8');
  }
}
