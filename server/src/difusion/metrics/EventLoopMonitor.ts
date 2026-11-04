import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export interface EventLoopDelaySample {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Momento en que se cerró la muestra */
  atMs: number;
}

/**
 * Mide el retraso del Event Loop con perf_hooks.monitorEventLoopDelay (RT-4).
 * El histograma se reinicia en cada muestra para que el p99 refleje la ventana actual
 * (el pico) y no el promedio de toda la jornada.
 */
export class EventLoopMonitor {
  private readonly histogram: IntervalHistogram;
  private timer: NodeJS.Timeout | null = null;
  private last: EventLoopDelaySample = { p50Ms: 0, p99Ms: 0, maxMs: 0, atMs: Date.now() };
  private readonly listeners: Array<(sample: EventLoopDelaySample) => void> = [];

  constructor(
    private readonly sampleEveryMs = 5_000,
    resolutionMs = 10,
  ) {
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  }

  start(): void {
    this.histogram.enable();
    this.timer = setInterval(() => this.takeSample(), this.sampleEveryMs);
    this.timer.unref();
  }

  stop(): void {
    this.histogram.disable();
    if (this.timer) clearInterval(this.timer);
  }

  get lastSample(): EventLoopDelaySample {
    return this.last;
  }

  onSample(listener: (sample: EventLoopDelaySample) => void): void {
    this.listeners.push(listener);
  }

  private takeSample(): void {
    const toMs = (ns: number): number => Math.round((ns / 1e6) * 100) / 100;
    this.last = {
      p50Ms: toMs(this.histogram.percentile(50)),
      p99Ms: toMs(this.histogram.percentile(99)),
      maxMs: toMs(this.histogram.max),
      atMs: Date.now(),
    };
    this.histogram.reset();
    for (const listener of this.listeners) listener(this.last);
  }
}
