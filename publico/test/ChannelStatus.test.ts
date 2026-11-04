import { expect, test } from 'vitest';
import type { PublicEvent } from '@votaciones/shared';
import { BaseResultsChannel } from '../src/transport/BaseResultsChannel.js';
import type { ChannelEvents, ChannelStatus } from '../src/transport/ResultsChannel.js';
import { ResultsStore } from '../src/state/ResultsStore.js';

class TestChannel extends BaseResultsChannel {
  readonly transport = 'SSE';
  constructor(store: ResultsStore, events: ChannelEvents) { super('', store, events); }
  protected open() { this.connected(); }
  protected close() {}
  receive(event: PublicEvent) { this.deliver(event); }
}

test('la vista recibe la instancia al llegar el primer evento y al cambiar de réplica', () => {
  const store = new ResultsStore(['dep']);
  const statuses: ChannelStatus[] = [];
  const channel = new TestChannel(store, {
    onStatus: status => statuses.push({ ...status }),
    onEvent: event => store.apply(event),
  });
  channel.start();
  expect(statuses.at(-1)?.phase).toBe('conectado');
  expect(statuses.at(-1)?.instance).toBeNull();
  channel.receive({ type: 'snapshot', topic: 'dep', totals: { C1: 10 }, to: '100-0', reason: 'inicial', instance: 'replica-1' });
  expect(statuses.at(-1)?.instance).toBe('replica-1');
  channel.receive({ type: 'status', frozen: false, sinceMs: null, instance: 'replica-2' });
  expect(statuses.at(-1)?.instance).toBe('replica-2');
  expect(statuses.at(-1)?.phase).toBe('conectado');
});
