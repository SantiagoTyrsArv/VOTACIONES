export type AdmissionDecision = { admitted: true } | { admitted: false; retryAfterSec: number };

/**
 * Control de admisión por instancia (RF-10, avalancha de reconexión).
 *
 * Cubeta de fichas: como máximo "maxPerSecond" conexiones nuevas por segundo, con ráfagas
 * de hasta ese mismo tamaño. El exceso recibe 503 + Retry-After ALEATORIO: si todos los
 * rechazados recibieran el mismo valor volverían todos juntos y repetirían la avalancha.
 * Es la defensa del servidor; la del cliente es el backoff exponencial con full jitter.
 */
export class AdmissionController {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly maxPerSecond: number,
    private readonly maxRetryAfterSec = 10,
    private readonly random: () => number = Math.random,
    nowMs = Date.now(),
  ) {
    this.tokens = maxPerSecond;
    this.lastRefillMs = nowMs;
  }

  tryAdmit(nowMs = Date.now()): AdmissionDecision {
    this.refill(nowMs);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { admitted: true };
    }
    return { admitted: false, retryAfterSec: 1 + Math.floor(this.random() * this.maxRetryAfterSec) };
  }

  private refill(nowMs: number): void {
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.maxPerSecond, this.tokens + elapsedSec * this.maxPerSecond);
    this.lastRefillMs = nowMs;
  }
}
