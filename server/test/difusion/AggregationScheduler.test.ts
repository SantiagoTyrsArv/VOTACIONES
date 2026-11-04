import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { Registry } from 'prom-client';
import { AggregationScheduler } from '../../src/difusion/aggregation/AggregationScheduler.js';
import { DeltaCondenser } from '../../src/difusion/aggregation/DeltaCondenser.js';
import type { DirtyTopicSource } from '../../src/difusion/aggregation/DirtyTopicTracker.js';
import { BackpressurePolicy } from '../../src/difusion/backpressure/BackpressurePolicy.js';
import type { PublicConnection } from '../../src/difusion/connections/PublicConnection.js';
import { CatchUpService } from '../../src/difusion/continuity/CatchUpService.js';
import { ConnectionSynchronizer } from '../../src/difusion/continuity/ConnectionSynchronizer.js';
import { TopicCursorBook } from '../../src/difusion/continuity/TopicCursorBook.js';
import { BatchFanout } from '../../src/difusion/fanout/BatchFanout.js';
import { PublicBroadcaster } from '../../src/difusion/fanout/PublicBroadcaster.js';
import { DifusionMetrics } from '../../src/difusion/metrics/DifusionMetrics.js';
import { TopicRegistry } from '../../src/difusion/topics/TopicRegistry.js';
import { FakeConnection } from './FakeConnection.js';
import { InMemoryResults } from './InMemoryResults.js';

class ManualDirtySource implements DirtyTopicSource {
  readonly dirty = new Set<string>();
  markAll(): void {}
  take(filter: (topic: string) => boolean): string[] {
    const taken = [...this.dirty].filter(filter);
    taken.forEach((topic) => this.dirty.delete(topic));
    return taken;
  }
}

/** Reconstruye el estado que vería el navegador aplicando la regla de continuidad. */
function clientState(connection: FakeConnection, topic: string): Record<string, number> {
  const state: Record<string, number> = {};
  for (const { event } of connection.received) {
    if (event.type === 'snapshot' && event.topic === topic) Object.assign(state, event.totals);
    if (event.type === 'delta' && event.topic === topic) Object.assign(state, event.changes);
  }
  return state;
}

function setup() {
  const results = new InMemoryResults(Date.now() - 60_000);
  const registry = new TopicRegistry<PublicConnection>();
  const cursors = new TopicCursorBook();
  const condenser = new DeltaCondenser('test');
  const metrics = new DifusionMetrics(new Registry(), 'test', () => ({ sse: registry.size, ws: 0 }));
  const broadcaster = new PublicBroadcaster(new BatchFanout(), new BackpressurePolicy(), {
    onDelivered: (c, m) => metrics.messageSent(m.event.type, c.transport, m.byteLength),
    onLagging: () => {},
    onDisconnected: () => {},
  });
  const dirty = new ManualDirtySource();
  const scheduler = new AggregationScheduler(
    registry, dirty, results, condenser, cursors, broadcaster, metrics, 'lotes', pino({ level: 'silent' }),
  );
  const synchronizer = new ConnectionSynchronizer(new CatchUpService(results, condenser, 'test'), cursors, {
    onCatchUpSent: () => {},
  });
  return { results, registry, dirty, scheduler, synchronizer, metrics };
}

describe('AggregationScheduler (RF-4)', () => {
  it('60 actas en una ventana producen UN mensaje por conexión', async () => {
    const { results, registry, dirty, scheduler, synchronizer, metrics } = setup();
    results.apply('mun:11', 'A0', { C1: 1, mesas_inf: 1 });

    const connections = Array.from({ length: 1_000 }, () => new FakeConnection(['mun:11']));
    for (const connection of connections) {
      registry.add(connection);
      await synchronizer.synchronize(connection);
    }

    for (let i = 1; i <= 60; i++) {
      results.apply('mun:11', `A${i}`, { C1: i % 3, C2: 1, mesas_inf: 1 });
      metrics.actaNoticeReceived(registry.size);
    }
    dirty.dirty.add('mun:11');
    await scheduler.tick();

    for (const connection of connections) {
      expect(connection.received.filter((m) => m.event.type === 'delta')).toHaveLength(1);
      expect(clientState(connection, 'mun:11')).toEqual(results.totalsOf('mun:11'));
    }
    const stats = metrics.snapshot();
    expect(stats.naiveEquivalentMessages).toBe(60_000);
    expect(stats.messagesSent).toBe(1_000);
  });

  it('el tópico departamental espera su ventana de 5 s', async () => {
    const { results, registry, dirty, scheduler, synchronizer } = setup();
    const connection = new FakeConnection(['dep']);
    registry.add(connection);
    await synchronizer.synchronize(connection);

    const t0 = 1_000_000;
    results.apply('dep', 'A1', { C1: 1 });
    dirty.dirty.add('dep');
    await scheduler.tick(t0);
    results.apply('dep', 'A2', { C1: 1 });
    dirty.dirty.add('dep');
    await scheduler.tick(t0 + 2_000);
    expect(connection.received.filter((m) => m.event.type === 'delta')).toHaveLength(1);

    await scheduler.tick(t0 + 5_000);
    expect(connection.received.filter((m) => m.event.type === 'delta')).toHaveLength(2);
    expect(clientState(connection, 'dep')).toEqual(results.totalsOf('dep'));
  });

  it('un cliente que vuelve tras 30 s queda igual que uno que nunca se fue', async () => {
    const { results, registry, dirty, scheduler, synchronizer } = setup();
    results.apply('pue:176', 'A0', { C1: 5, mesas_inf: 1 });
    const stayed = new FakeConnection(['pue:176']);
    const leaver = new FakeConnection(['pue:176']);
    for (const c of [stayed, leaver]) {
      registry.add(c);
      await synchronizer.synchronize(c);
    }

    // El que se va se desconecta; mientras tanto llegan actas y una corrección
    registry.remove(leaver);
    leaver.disconnect();
    results.apply('pue:176', 'A1', { C2: 7, mesas_inf: 1 });
    results.apply('pue:176', 'A1', { C2: -7, C3: 7 }, { reason: 'correccion', version: 2, previousVersion: 1 });
    dirty.dirty.add('pue:176');
    await scheduler.tick();

    // Vuelve (a cualquier instancia) con su cursor
    const back = new FakeConnection(['pue:176'], new Map([['pue:176', leaver.cursorOf('pue:176')!]]));
    registry.add(back);
    await synchronizer.synchronize(back);

    const expected = results.totalsOf('pue:176');
    expect(clientState(stayed, 'pue:176')).toEqual(expected);
    expect({ ...clientState(leaver, 'pue:176'), ...clientState(back, 'pue:176') }).toEqual(expected);
    expect(back.received).toHaveLength(1);
    expect(back.received[0]!.event.type).toBe('delta');
  });
});
