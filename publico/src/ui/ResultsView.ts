import { TotalsField, type Totals } from '@votaciones/shared';
import type { ResultsStore } from '../state/ResultsStore.js';
import type { ChannelStatus } from '../transport/ResultsChannel.js';

/** Campos que no son candidatos. */
const NON_CANDIDATE = new Set<string>([
  TotalsField.voters,
  TotalsField.reportedTables,
  TotalsField.totalTables,
  'NULO',
  'NO_MARCADO',
]);

export interface LiveMetrics {
  lastLatencyMs: number | null;
  messages: number;
  inpMs: number | null;
  inpRating: string | null;
}

const numberFormat = new Intl.NumberFormat('es-CO');
const percentFormat = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const timeFormat = new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Vista de resultados. Para que la página sea usable en un teléfono de gama baja (RT-9):
 *  - repinta como máximo una vez por cuadro (requestAnimationFrame agrupa los cambios);
 *  - reutiliza los nodos de cada candidato y solo cambia textos y anchos (sin reconstruir el DOM);
 *  - las barras se animan con transform (composición en GPU, sin recalcular layout).
 */
export class ResultsView {
  private frameRequested = false;
  private status: ChannelStatus | null = null;
  private readonly rows = new Map<string, { root: HTMLElement; votes: HTMLElement; percent: HTMLElement; bar: HTMLElement }>();

  constructor(
    private readonly root: HTMLElement,
    private readonly store: ResultsStore,
    private readonly mainTopic: string,
    private readonly metrics: LiveMetrics,
  ) {
    store.onChange(() => this.schedule());
  }

  updateStatus(status: ChannelStatus): void {
    this.status = { ...status };
    this.schedule();
  }

  schedule(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  private render(): void {
    const view = this.store.view(this.mainTopic);
    const totals = view?.totals ?? {};
    this.renderHeader(totals, view?.loaded ?? false);
    this.renderCandidates(totals);
    this.renderCorrections();
    this.renderFooter();
  }

  private renderHeader(totals: Totals, loaded: boolean): void {
    const reported = totals[TotalsField.reportedTables] ?? 0;
    const total = totals[TotalsField.totalTables] ?? 0;
    const percent = total > 0 ? (reported / total) * 100 : 0;
    this.text('[data-mesas]', loaded ? `${numberFormat.format(reported)} de ${numberFormat.format(total)} mesas informadas` : 'Cargando resultados…');
    this.text('[data-mesas-pct]', `${percentFormat.format(percent)} %`);
    this.element('[data-mesas-bar]').style.transform = `scaleX(${Math.min(percent, 100) / 100})`;
    this.text('[data-sufragantes]', numberFormat.format(totals[TotalsField.voters] ?? 0));
    this.text('[data-nulos]', numberFormat.format(totals.NULO ?? 0));
    this.text('[data-no-marcados]', numberFormat.format(totals.NO_MARCADO ?? 0));

    const frozenSince = this.store.frozenSinceMs;
    const banner = this.element('[data-congelado]');
    banner.hidden = frozenSince === null;
    if (frozenSince !== null) {
      banner.textContent = `Resultados en pausa desde las ${timeFormat.format(frozenSince)}: la consolidación no está disponible. Las cifras mostradas no están cambiando.`;
    }
  }

  private renderCandidates(totals: Totals): void {
    const candidates = Object.entries(totals)
      .filter(([field]) => !NON_CANDIDATE.has(field))
      .sort((a, b) => b[1] - a[1]);
    const valid = candidates.reduce((sum, [, votes]) => sum + votes, 0);
    const list = this.element('[data-candidatos]');

    candidates.forEach(([field, votes], index) => {
      const row = this.rowFor(field, list);
      const share = valid > 0 ? votes / valid : 0;
      row.votes.textContent = numberFormat.format(votes);
      row.percent.textContent = `${percentFormat.format(share * 100)} %`;
      row.bar.style.transform = `scaleX(${share})`;
      row.root.style.order = String(index);
    });
  }

  private rowFor(field: string, list: HTMLElement) {
    let row = this.rows.get(field);
    if (!row) {
      const root = document.createElement('li');
      root.className = 'candidato';
      root.innerHTML = `
        <div class="candidato__fila"><span class="candidato__nombre"></span>
          <span class="candidato__votos"></span><span class="candidato__pct"></span></div>
        <div class="barra"><div class="barra__relleno"></div></div>`;
      root.querySelector('.candidato__nombre')!.textContent = field === 'BLANCO' ? 'Voto en blanco' : `Candidato ${field.replace(/^C/, '')}`;
      row = {
        root,
        votes: root.querySelector('.candidato__votos')!,
        percent: root.querySelector('.candidato__pct')!,
        bar: root.querySelector('.barra__relleno')!,
      };
      list.append(root);
      this.rows.set(field, row);
    }
    return row;
  }

  private renderCorrections(): void {
    const corrections = this.store.recentCorrections.slice(0, 5);
    const reconcile = this.store.lastReconcile;
    const container = this.element('[data-correcciones]');
    container.hidden = corrections.length === 0 && reconcile === null;
    const items = corrections.map(
      (c) =>
        `<li>${timeFormat.format(c.atMs)} · Corrección del acta <strong>${escapeHtml(c.acta)}</strong> (v${c.fromVersion} → v${c.toVersion})</li>`,
    );
    if (reconcile) {
      items.unshift(
        `<li>${timeFormat.format(reconcile.atMs)} · Al reconectar se actualizaron las cifras: mientras estuvo desconectado se corrigieron actas, por eso bajó <strong>${reconcile.decreasedFields.map(escapeHtml).join(', ')}</strong>.</li>`,
      );
    }
    this.element('[data-correcciones-lista]').innerHTML = items.join('');
  }

  private renderFooter(): void {
    const status = this.status;
    if (status) {
      const phaseText =
        status.phase === 'conectado'
          ? 'En vivo'
          : status.phase === 'reconectando'
            ? `Reconectando en ${((status.nextRetryMs ?? 0) / 1000).toFixed(1)} s`
            : 'Conectando…';
      this.text('[data-fase]', phaseText);
      this.element('[data-fase]').dataset.fase = status.phase;
      this.text('[data-transporte]', status.transport);
      this.text('[data-instancia]', status.instance ?? '—');
      this.text('[data-reconexiones]', String(status.reconnects));
    }
    this.text('[data-latencia]', this.metrics.lastLatencyMs === null ? '—' : `${numberFormat.format(this.metrics.lastLatencyMs)} ms`);
    this.text('[data-mensajes]', numberFormat.format(this.metrics.messages));
    this.text('[data-inp]', this.metrics.inpMs === null ? 'interactúe para medir' : `${Math.round(this.metrics.inpMs)} ms (${this.metrics.inpRating})`);
    this.text('[data-anomalias]', String(this.store.anomalies));
  }

  private element(selector: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(selector)!;
  }

  private text(selector: string, value: string): void {
    const element = this.element(selector);
    if (element.textContent !== value) element.textContent = value;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
