import { EventEmitter } from 'node:events';
import type { RedisClient } from './RedisConnections.js';

export interface RedisHealthChange {
  healthy: boolean;
  /** Desde cuándo (ms) está en el estado actual */
  sinceMs: number;
}

/**
 * Sondea Redis con PING y un tiempo límite corto. Si falla, el sistema entra en modo
 * degradado (RF-10): /ready responde 503, los jurados reciben NO_REGISTRADA y el
 * público recibe "congelado". Emite "change" solo cuando el estado cambia.
 */
export class RedisHealthMonitor extends EventEmitter<{ change: [RedisHealthChange] }> {
  /** null = aún sin sondear; así el primer resultado siempre se notifica. */
  private healthy: boolean | null = null;
  private sinceMs = Date.now();
  private probing?: Promise<boolean>;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: RedisClient,
    private readonly intervalMs = 1_000,
    private readonly timeoutMs = 300,
  ) {
    super();
  }

  get isHealthy(): boolean {
    return this.healthy === true;
  }

  get stateSinceMs(): number {
    return this.sinceMs;
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  check(): Promise<boolean> {
    this.probing ??= this.probe().finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  private async probe(): Promise<boolean> {
    let ok = false;
    try {
      await withTimeout(this.client.ping(), this.timeoutMs);
      ok = true;
    } catch {
      ok = false;
    }
    if (ok !== this.healthy) {
      this.healthy = ok;
      this.sinceMs = Date.now();
      this.emit('change', { healthy: ok, sinceMs: this.sinceMs });
    }
    return ok;
  }
}

/** Rechaza la promesa si no termina en "ms" milisegundos. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tiempo agotado (${ms} ms)`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
