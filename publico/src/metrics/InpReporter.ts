import { onINP, type INPMetric } from 'web-vitals';

/**
 * Mide el INP (Interaction to Next Paint) real de la página con web-vitals y lo reporta al
 * servidor (histograma public_page_inp_ms), para demostrar RT-9 bajo carga.
 */
export class InpReporter {
  constructor(
    private readonly endpoint: string,
    private readonly onMeasure: (valueMs: number, rating: string) => void,
  ) {}

  start(): void {
    onINP((metric: INPMetric) => this.report(metric), { reportAllChanges: true });
  }

  private report(metric: INPMetric): void {
    this.onMeasure(metric.value, metric.rating);
    const body = JSON.stringify({ value: Math.round(metric.value), rating: metric.rating });
    // keepalive: el reporte sobrevive aunque el usuario cierre la pestaña
    void fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  }
}
