import { describe, expect, it } from 'vitest';
import { Topic, type PublicDelta } from '@votaciones/shared';
import { BackpressurePolicy } from '../../src/difusion/backpressure/BackpressurePolicy.js';
import { EncodedMessage } from '../../src/difusion/connections/EncodedMessage.js';
import { BatchFanout } from '../../src/difusion/fanout/BatchFanout.js';
import { PublicBroadcaster } from '../../src/difusion/fanout/PublicBroadcaster.js';
import { FakeConnection } from './FakeConnection.js';

const KB = 1024;

function delta(to: string): EncodedMessage {
  const event: PublicDelta = {
    type: 'delta',
    topic: Topic.DEPARTMENT.toString(),
    from: null,
    to,
    changes: { C1: 10 },
    actas: 1,
    corrections: [],
    oldestReceivedAtMs: 0,
    instance: 'test',
  };
  return new EncodedMessage(event);
}

describe('BackpressurePolicy (RF-9)', () => {
  const policy = new BackpressurePolicy();

  it('aplica los umbrales 64 KB / 1 MB al enviar', () => {
    const connection = new FakeConnection(['dep']);
    connection.pending = 10 * KB;
    expect(policy.beforeSend(connection)).toBe('enviar');
    connection.pending = 100 * KB;
    expect(policy.beforeSend(connection)).toBe('atrasar');
    connection.pending = 2 * 1024 * KB;
    expect(policy.beforeSend(connection)).toBe('desconectar');
  });

  it('reanuda bajo 16 KB y desconecta tras 60 s atrasada', () => {
    const connection = new FakeConnection(['dep']);
    connection.markLagging(1_000);
    connection.pending = 40 * KB;
    expect(policy.whileLagging(connection, 2_000)).toBe('esperar');
    connection.pending = 8 * KB;
    expect(policy.whileLagging(connection, 2_000)).toBe('reanudar');
    connection.pending = 40 * KB;
    expect(policy.whileLagging(connection, 62_000)).toBe('desconectar');
  });
});

describe('PublicBroadcaster', () => {
  const noop = { onDelivered: () => {}, onLagging: () => {}, onDisconnected: () => {} };
  const broadcaster = new PublicBroadcaster(new BatchFanout(), new BackpressurePolicy(), noop);

  it('solo envía a conexiones al día y avanza su cursor', async () => {
    const ready = new FakeConnection(['dep']);
    ready.markUpToDate();
    const syncing = new FakeConnection(['dep']);
    const slow = new FakeConnection(['dep']);
    slow.markUpToDate();
    slow.pending = 200 * KB;

    const result = await broadcaster.broadcast([ready, syncing, slow], delta('100-0'));

    expect(result.delivered).toBe(1);
    expect(result.lagged).toBe(1);
    expect(ready.cursorOf('dep')?.toString()).toBe('100-0');
    expect(syncing.received).toHaveLength(0);
    expect(slow.syncState).toBe('atrasada');
  });

  it('desconecta con orden de reconexión si el búfer supera 1 MB', async () => {
    const huge = new FakeConnection(['dep']);
    huge.markUpToDate();
    huge.pending = 5 * 1024 * KB;
    const result = await broadcaster.broadcast([huge], delta('101-0'));
    expect(result.disconnected).toBe(1);
    expect(huge.closedWith?.reason).toBe('contrapresion');
    expect(huge.isOpen).toBe(false);
  });
});
