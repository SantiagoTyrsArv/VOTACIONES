import { describe, expect, it } from 'vitest';
import { StreamId } from '@votaciones/shared';
import { DeltaCondenser } from '../../src/difusion/aggregation/DeltaCondenser.js';
import { CatchUpService } from '../../src/difusion/continuity/CatchUpService.js';
import { ConnectionSynchronizer } from '../../src/difusion/continuity/ConnectionSynchronizer.js';
import { TopicCursorBook } from '../../src/difusion/continuity/TopicCursorBook.js';
import { FakeConnection } from './FakeConnection.js';
import { InMemoryResults } from './InMemoryResults.js';

const condenser = new DeltaCondenser('test');

describe('DeltaCondenser (RF-4)', () => {
  it('condensa varias actas en un mensaje con valores absolutos', async () => {
    const results = new InMemoryResults();
    results.apply('dep', 'A1', { C1: 10, C2: 5, mesas_inf: 1 });
    results.apply('dep', 'A2', { C1: 3, mesas_inf: 1 });
    const records = await results.readAfter('dep', null, 100);

    const delta = condenser.condense('dep', null, records)!;

    expect(delta.actas).toBe(2);
    expect(delta.changes).toEqual({ C1: 13, C2: 5, mesas_inf: 2 });
    expect(delta.to).toBe(records[1]!.id.toString());
  });

  it('incluye correcciones y campos con cambio neto cero', async () => {
    const results = new InMemoryResults();
    results.apply('dep', 'A1', { C1: 10 });
    const from = results.apply('dep', 'A2', { C2: 4 });
    results.apply('dep', 'A2', { C2: -4, C3: 4 }, { reason: 'correccion', version: 2, previousVersion: 1 });
    results.apply('dep', 'A3', { C2: 4 });

    const delta = condenser.condense('dep', from, await results.readAfter('dep', from, 100))!;

    // C2: 4 (antes del cursor) − 4 (corrección) + 4 (A3) = 4 → aparece aunque su cambio neto sea 0
    expect(delta.changes).toEqual({ C2: 4, C3: 4 });
    expect(delta.corrections).toEqual([{ acta: 'A2', fromVersion: 1, toVersion: 2, reason: 'correccion' }]);
  });

  it('explica los retiros dudosos y las verificaciones', async () => {
    const results = new InMemoryResults();
    results.apply('dep', 'A1', { C1: 10 });
    results.apply('dep', 'A1', { C1: -10 }, { reason: 'retiro_dudosa', version: 2, previousVersion: 1 });
    results.apply('dep', 'A1', { C1: 10 }, { reason: 'verificacion', version: 3, previousVersion: 2 });

    const delta = condenser.condense('dep', null, await results.readAfter('dep', null, 100))!;

    expect(delta.corrections.map((item) => item.reason)).toEqual(['retiro_dudosa', 'verificacion']);
  });
});

describe('CatchUpService (RF-6)', () => {
  const now = 10_000;

  it('sin cursor entrega fotografía inicial', async () => {
    const results = new InMemoryResults();
    results.apply('dep', 'A1', { C1: 7 });
    const event = await new CatchUpService(results, condenser, 'test').resume('dep', null, now);
    expect(event).toMatchObject({ type: 'snapshot', reason: 'inicial', totals: { C1: 7 } });
  });

  it('tras una ausencia corta entrega solo lo perdido, condensado', async () => {
    const results = new InMemoryResults();
    const cursor = results.apply('dep', 'A1', { C1: 7 });
    results.apply('dep', 'A2', { C2: 2 });
    results.apply('dep', 'A3', { C2: 1 });

    const event = await new CatchUpService(results, condenser, 'test').resume('dep', cursor, now);

    expect(event).toMatchObject({ type: 'delta', actas: 2, changes: { C2: 3 }, from: cursor.toString() });
  });

  it('al día no envía nada', async () => {
    const results = new InMemoryResults();
    const cursor = results.apply('dep', 'A1', { C1: 7 });
    expect(await new CatchUpService(results, condenser, 'test').resume('dep', cursor, now)).toBeNull();
  });

  it('usa fotografía si el cursor fue recortado, está muy atrás o la ausencia es larga', async () => {
    const results = new InMemoryResults();
    const old = results.apply('dep', 'A0', { C1: 1 });
    for (let i = 1; i <= 5; i++) results.apply('dep', `A${i}`, { C1: 1 });
    const service = new CatchUpService(results, condenser, 'test', { maxEntries: 3, maxAbsenceMs: 60_000 });

    expect(await service.resume('dep', old, now)).toMatchObject({ reason: 'demasiado_atras' });
    results.trim('dep', 2);
    expect(await service.resume('dep', old, now)).toMatchObject({ reason: 'cursor_recortado' });
    expect(await service.resume('dep', old, old.timestampMs + 120_000)).toMatchObject({ reason: 'ausencia_larga' });
    expect(await service.resume('dep', StreamId.parse('999999-0'), now)).toMatchObject({ reason: 'cursor_recortado' });
  });
});

describe('ConnectionSynchronizer', () => {
  it('deja al cliente igual que uno que nunca se desconectó', async () => {
    const results = new InMemoryResults(Date.now() - 30_000);
    const book = new TopicCursorBook();
    const service = new CatchUpService(results, condenser, 'test');
    const synchronizer = new ConnectionSynchronizer(service, book, { onCatchUpSent: () => {} });

    results.apply('mun:11', 'A1', { C1: 10, mesas_inf: 1 });
    const cursor = results.apply('mun:11', 'A2', { C2: 3, mesas_inf: 1 });
    results.apply('mun:11', 'A3', { C1: 5, mesas_inf: 1 });

    const returning = new FakeConnection(['mun:11'], new Map([['mun:11', cursor]]));
    expect(await synchronizer.synchronize(returning)).toBe(true);

    // Reconstruye el estado del cliente: totales al momento del cursor + lo recibido
    const state: Record<string, number> = { C1: 10, C2: 3, mesas_inf: 2 };
    for (const message of returning.received) {
      const event = message.event;
      if (event.type === 'delta') Object.assign(state, event.changes);
    }
    expect(state).toEqual(results.totalsOf('mun:11'));
    expect(returning.syncState).toBe('al_dia');
    expect(book.get('mun:11')?.toString()).toBe(returning.cursorOf('mun:11')?.toString());
  });
});
