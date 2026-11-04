import type { AppConfig } from '../config/AppConfig.js';
import type { AggregationOptions } from './aggregation/AggregationScheduler.js';
import type { BackpressureThresholds } from './backpressure/BackpressurePolicy.js';
import type { CatchUpOptions } from './continuity/CatchUpService.js';
import type { FanoutMode, FanoutOptions } from './fanout/BatchFanout.js';

/**
 * Parámetros de la difusión pública. Todos tienen valor por defecto y se pueden cambiar por
 * variables de entorno para las mediciones (p. ej. FANOUT_MODE=ingenuo para comparar).
 */
export class DifusionSettings {
  private constructor(
    readonly aggregation: AggregationOptions,
    readonly fanout: FanoutOptions,
    readonly backpressure: BackpressureThresholds,
    readonly catchUp: CatchUpOptions,
    readonly admissionPerSecond: number,
    readonly heartbeatMs: number,
    readonly laggingSweepMs: number,
    readonly publicDir: string | null,
    readonly maxSseLifetimeMs: number,
    readonly sseLifetimeJitterMs: number,
  ) {}

  static from(config: AppConfig): DifusionSettings {
    const mode: FanoutMode = config.string('FANOUT_MODE', 'lotes') === 'ingenuo' ? 'ingenuo' : 'lotes';
    const KB = 1024;
    return new DifusionSettings(
      {
        windowMs: config.number('PUBLIC_WINDOW_MS', 2_000),
        departmentWindowMs: config.number('PUBLIC_DEP_WINDOW_MS', 5_000),
        safetySweepMs: config.number('PUBLIC_SAFETY_SWEEP_MS', 15_000),
        readBatch: 500,
      },
      {
        batchSize: config.number('FANOUT_BATCH', 500),
        batchBudgetMs: config.number('FANOUT_BUDGET_MS', 5),
        mode,
      },
      {
        lagBytes: config.number('BP_LAG_KB', 64) * KB,
        resumeBytes: config.number('BP_RESUME_KB', 16) * KB,
        disconnectBytes: config.number('BP_DISCONNECT_KB', 1024) * KB,
        maxLagMs: config.number('BP_MAX_LAG_MS', 60_000),
      },
      {
        maxEntries: config.number('CATCHUP_MAX_ENTRIES', 200),
        maxAbsenceMs: config.number('CATCHUP_MAX_ABSENCE_MS', 5 * 60_000),
      },
      config.number('ADMISSION_PER_SEC', 500),
      config.number('PUBLIC_HEARTBEAT_MS', 15_000),
      1_000,
      process.env.PUBLIC_DIR ?? null,
      config.number('SSE_MAX_LIFETIME_MS', 14 * 60_000),
      30_000,
    );
  }
}
