import { describe, expect, it } from 'vitest';
import { BatchFanout } from '../../src/difusion/fanout/BatchFanout.js';

describe('BatchFanout (RF-4)', () => {
  const recipients = Array.from({ length: 2_000 }, (_, i) => i);

  it('en modo lotes cede el Event Loop entre lotes', async () => {
    const fanout = new BatchFanout({ batchSize: 500, batchBudgetMs: 1_000, mode: 'lotes' });
    const order: string[] = [];
    let visited = 0;
    // Simula un jurado cuyo mensaje llega mientras se difunde
    setImmediate(() => order.push(`jurado atendido tras ${visited}`));

    const result = await fanout.forEach(recipients, () => {
      visited++;
    });

    expect(result.visited).toBe(2_000);
    expect(result.batches).toBe(5);
    expect(order).toEqual(['jurado atendido tras 500']);
  });

  it('en modo ingenuo bloquea hasta terminar (línea base de comparación)', async () => {
    const fanout = new BatchFanout({ batchSize: 500, batchBudgetMs: 5, mode: 'ingenuo' });
    const order: string[] = [];
    let visited = 0;
    setImmediate(() => order.push(`jurado atendido tras ${visited}`));

    await fanout.forEach(recipients, () => {
      visited++;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual(['jurado atendido tras 2000']);
  });

  it('corta el lote por tiempo aunque no llegue al tamaño', async () => {
    const fanout = new BatchFanout({ batchSize: 1_000_000, batchBudgetMs: 1, mode: 'lotes' });
    const busyWait = (): void => {
      const until = performance.now() + 0.05;
      while (performance.now() < until);
    };
    const result = await fanout.forEach(recipients, busyWait);
    expect(result.batches).toBeGreaterThan(1);
  });
});
