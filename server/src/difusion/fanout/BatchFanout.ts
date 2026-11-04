import { performance } from 'node:perf_hooks';

export type FanoutMode = 'lotes' | 'ingenuo';

export interface FanoutOptions {
  /** Máximo de conexiones atendidas antes de ceder el Event Loop. */
  readonly batchSize: number;
  /** Tiempo máximo (ms) de un lote antes de ceder, lo que ocurra primero. */
  readonly batchBudgetMs: number;
  /** "ingenuo" recorre todo sin ceder; solo existe para medir la diferencia. */
  readonly mode: FanoutMode;
}

export interface FanoutResult {
  visited: number;
  batches: number;
  durationMs: number;
}

export const DEFAULT_FANOUT_OPTIONS: FanoutOptions = { batchSize: 500, batchBudgetMs: 5, mode: 'lotes' };

/** Cada cuántas visitas se consulta el reloj (performance.now también cuesta). */
const CLOCK_CHECK_EVERY = 64;

/**
 * Recorre destinatarios en lotes y cede el Event Loop entre lotes (RF-4, RT-4).
 *
 * El recorrido ingenuo de 50.000 conexiones es un bucle síncrono: mientras corre, Node no
 * atiende ningún otro evento (ni jurados, ni auditores, ni latidos). Cortarlo en lotes de
 * 500 conexiones o 5 ms y hacer "await setImmediate" entre lotes deja que la fase de I/O
 * procese lo pendiente; el retraso del Event Loop queda acotado por el tamaño del lote.
 */
export class BatchFanout {
  constructor(private readonly options: FanoutOptions = DEFAULT_FANOUT_OPTIONS) {}

  get mode(): FanoutMode {
    return this.options.mode;
  }

  async forEach<T>(recipients: Iterable<T>, visit: (recipient: T) => void): Promise<FanoutResult> {
    const start = performance.now();
    if (this.options.mode === 'ingenuo') {
      let visited = 0;
      for (const recipient of recipients) {
        visit(recipient);
        visited++;
      }
      return { visited, batches: 1, durationMs: performance.now() - start };
    }

    let visited = 0;
    let inBatch = 0;
    let batches = 1;
    let batchStart = start;
    for (const recipient of recipients) {
      visit(recipient);
      visited++;
      inBatch++;
      const sizeReached = inBatch >= this.options.batchSize;
      const budgetReached =
        inBatch % CLOCK_CHECK_EVERY === 0 && performance.now() - batchStart >= this.options.batchBudgetMs;
      if (sizeReached || budgetReached) {
        await yieldToEventLoop();
        batches++;
        inBatch = 0;
        batchStart = performance.now();
      }
    }
    return { visited, batches, durationMs: performance.now() - start };
  }
}

/** setImmediate se ejecuta DESPUÉS de la fase de I/O: los demás clientes alcanzan a ser atendidos. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
