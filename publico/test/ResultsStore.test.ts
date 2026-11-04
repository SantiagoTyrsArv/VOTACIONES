import { describe, expect, it } from 'vitest';
import { ReconnectBackoff, type PublicDelta, type PublicSnapshot } from '@votaciones/shared';
import { ResultsStore } from '../src/state/ResultsStore.js';

const snapshot = (to: string, totals: Record<string, number>): PublicSnapshot => ({
  type: 'snapshot', topic: 'dep', to, totals, reason: 'inicial', instance: 'i1',
});

const delta = (from: string | null, to: string, changes: Record<string, number>, corrected = false): PublicDelta => ({
  type: 'delta', topic: 'dep', from, to, changes, actas: 1,
  corrections: corrected ? [{ acta: 'E14-1', fromVersion: 1, toVersion: 2, reason: 'correccion' }] : [],
  oldestReceivedAtMs: 0, instance: 'i1',
});

describe('ResultsStore (continuidad en el navegador)', () => {
  it('aplica deltas contiguos y descarta duplicados', () => {
    const store = new ResultsStore(['dep']);
    expect(store.apply(snapshot('10-0', { C1: 5, C2: 1 }))).toBe('aplicado');
    expect(store.apply(delta('10-0', '20-0', { C1: 8 }))).toBe('aplicado');
    expect(store.apply(delta('10-0', '20-0', { C1: 8 }))).toBe('duplicado');
    expect(store.view('dep')?.totals).toEqual({ C1: 8, C2: 1 });
    expect(store.cursorParam()).toBe('dep@20-0');
  });

  it('acepta un delta que se solapa con lo que ya tenía (valores absolutos)', () => {
    const store = new ResultsStore(['dep']);
    store.apply(snapshot('15-0', { C1: 6 }));
    expect(store.apply(delta('10-0', '20-0', { C1: 9 }))).toBe('aplicado');
    expect(store.view('dep')?.totals.C1).toBe(9);
  });

  it('detecta huecos para pedir reanudar', () => {
    const store = new ResultsStore(['dep']);
    store.apply(snapshot('10-0', { C1: 5 }));
    expect(store.apply(delta('15-0', '20-0', { C1: 9 }))).toBe('hueco');
    expect(store.view('dep')?.totals.C1).toBe(5);
  });

  it('cuenta retrocesos sin explicación y registra las correcciones', () => {
    const store = new ResultsStore(['dep']);
    store.apply(snapshot('10-0', { C1: 50 }));
    store.apply(delta('10-0', '20-0', { C1: 40 }, true));
    expect(store.anomalies).toBe(0);
    expect(store.recentCorrections[0]).toMatchObject({ acta: 'E14-1', fromVersion: 1, toVersion: 2 });
    store.apply(delta('20-0', '30-0', { C1: 30 }));
    expect(store.anomalies).toBe(1);
  });

  it('si una fotografía baja un número, deja un aviso de correcciones en ausencia', () => {
    const store = new ResultsStore(['dep']);
    store.apply(snapshot('10-0', { C1: 50, C2: 10 }));
    store.apply(snapshot('90-0', { C1: 45, C2: 30 }));
    expect(store.lastReconcile?.decreasedFields).toEqual(['C1']);
    expect(store.anomalies).toBe(0);
  });
});

describe('ReconnectBackoff (full jitter)', () => {
  it('crece exponencialmente con tope y se reinicia', () => {
    const backoff = new ReconnectBackoff({ baseMs: 1_000, capMs: 8_000, jitter: false });
    expect([1, 2, 3, 4, 5].map(() => backoff.nextDelayMs())).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  it('con jitter reparte la espera entre 0 y el techo', () => {
    const backoff = new ReconnectBackoff({ baseMs: 1_000, capMs: 30_000, jitter: true }, () => 0.5);
    expect(backoff.nextDelayMs()).toBe(500);
    expect(backoff.nextDelayMs()).toBe(1_000);
    expect(backoff.nextDelayAtLeast(5_000)).toBe(5_000);
  });
});
