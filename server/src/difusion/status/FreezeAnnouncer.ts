import type { PublicStatus } from '@votaciones/shared';
import { EncodedMessage } from '../connections/EncodedMessage.js';

/**
 * Estado degradado visible para el público (RF-10). Si Redis deja de responder, la página
 * no se queda en silencio mostrando un número viejo como si fuera actual: recibe
 * "congelado desde hh:mm" y lo muestra. Al volver Redis, recibe "descongelado".
 */
export class FreezeAnnouncer {
  private frozen = false;
  private sinceMs: number | null = null;

  constructor(private readonly instanceId: string) {}

  get isFrozen(): boolean {
    return this.frozen;
  }

  get frozenSinceMs(): number | null {
    return this.sinceMs;
  }

  /** @returns el mensaje a difundir si el estado cambió; null si no cambió. */
  update(healthy: boolean, sinceMs: number): EncodedMessage | null {
    const frozen = !healthy;
    if (frozen === this.frozen) return null;
    this.frozen = frozen;
    this.sinceMs = frozen ? sinceMs : null;
    return this.currentStatus();
  }

  currentStatus(): EncodedMessage {
    const event: PublicStatus = { type: 'status', frozen: this.frozen, sinceMs: this.sinceMs, instance: this.instanceId };
    return new EncodedMessage(event);
  }
}
