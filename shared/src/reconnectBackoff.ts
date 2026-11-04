export interface BackoffOptions {
  /** Espera base del primer reintento (ms). */
  readonly baseMs: number;
  /** Tope de la espera (ms). */
  readonly capMs: number;
  /** false = backoff exponencial sin azar (solo para comparar en la gráfica de avalancha). */
  readonly jitter: boolean;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, capMs: 30_000, jitter: true };

/**
 * Backoff exponencial con "full jitter" (RF-10):
 *   espera = aleatorio(0, min(tope, base × 2^intento))
 *
 * Cuando muere una instancia, sus ~50.000 clientes detectan el corte casi en el mismo
 * milisegundo. Sin azar, todos reintentan juntos en t = 1 s, 2 s, 4 s... y cada oleada
 * golpea a las siete instancias restantes. Con full jitter los reintentos se reparten
 * uniformemente en la ventana y el pico de reconexiones por segundo se aplana.
 * El contador se reinicia al conectar con éxito.
 */
export class ReconnectBackoff {
  private attempt = 0;

  constructor(
    private readonly options: BackoffOptions = DEFAULT_BACKOFF,
    private readonly random: () => number = Math.random,
  ) {}

  /** Espera antes del próximo intento; incrementa el contador. */
  nextDelayMs(): number {
    const ceiling = Math.min(this.options.capMs, this.options.baseMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return this.options.jitter ? Math.floor(this.random() * ceiling) : ceiling;
  }

  /** Respeta una espera mínima indicada por el servidor (Retry-After / orden de reconexión). */
  nextDelayAtLeast(minimumMs: number): number {
    return Math.max(minimumMs, this.nextDelayMs());
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}
