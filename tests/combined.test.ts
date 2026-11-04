import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomInt } from 'node:crypto';
import { createServer, connect, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import { serializeStreamEntry, type PublicEvent } from '@votaciones/shared';
import { buildApp } from '../server/app.js';
import { config, eventually, seed, TestClient } from './helpers.js';
import { FakeActaFeeder } from '../carga/src/publico/FakeActaFeeder.js';
import type { RedisConnection } from '../server/src/verificacion/store.js';

test('B y C comparten servidor: SSE, WS, polling, reconexión y métricas entre dos réplicas', async () => {
  const first = await buildApp(config('bc-test-1'));
  const second = await buildApp(config('bc-test-2'));
  const url1 = await first.app.listen({ host: '127.0.0.1', port: 0 });
  const url2 = await second.app.listen({ host: '127.0.0.1', port: 0 });
  const topic = `mun:${randomInt(500000, 999999)}`;
  const keys = [`tot:${topic}`, `st:${topic}`];
  const sockets: WebSocket[] = [];
  const auditors: TestClient[] = [];
  const controller = new AbortController();
  let reading: Promise<void> | undefined;
  const publicWs = async (url: string) => {
    const messages: PublicEvent[] = [];
    const socket = new WebSocket(url);
    sockets.push(socket);
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as PublicEvent));
    await once(socket, 'open');
    return { socket, messages };
  };
  try {
    for (const url of [url1, url2]) {
      assert.equal((await fetch(url + '/ready')).status, 200);
      assert.match(await (await fetch(url + '/publico/')).text(), /<html/);
      assert.match(await (await fetch(url + '/')).text(), /<html/);
    }
    const ws = await publicWs(url1.replace('http', 'ws') + `/ws/publico?topics=${topic}`);
    await eventually(async () => ws.messages.some((m) => m.type === 'snapshot'), Boolean);
    const response = await fetch(url2 + `/publico/sse?topics=${topic}`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    let sse = '';
    reading = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          sse += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        reader.releaseLock();
      }
    })();
    await eventually(async () => sse.includes('"type":"snapshot"'), Boolean);
    const a = await new TestClient(url1.replace('http', 'ws') + '/ws/auditor').ready('demo-ana');
    const b = await new TestClient(url2.replace('http', 'ws') + '/ws/auditor').ready('demo-luis');
    auditors.push(a, b);
    const id = await seed(first.store);
    const contest = await Promise.all([
      a.request({ type: 'take', caseId: id }),
      b.request({ type: 'take', caseId: id }),
    ]);
    assert.deepEqual(contest.map((result) => result?.code).sort(), ['BUSY', 'TAKEN']);

    // Fixture del contrato de A: no se presenta como consolidación electoral real.
    const publish = async (votes: number, version: number) => {
      const totals = { C1: votes, sufragantes: votes, mesas_inf: 1, mesas_total: 1 };
      const rows = await first.store.redis
        .multi()
        .hSet(keys[0]!, Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, String(v)])))
        .xAdd(
          keys[1]!,
          '*',
          serializeStreamEntry({
            acta: id,
            version,
            previousVersion: version - 1,
            reason: version > 1 ? 'correccion' : 'nueva',
            delta: { C1: version > 1 ? -10 : votes },
            totals,
            receivedAtMs: Date.now(),
          }),
        )
        .exec();
      const cursor = String(rows[1]);
      await first.store.redis.publish(
        'ch:actas',
        JSON.stringify({ acta: id, topics: [topic], streamIds: { [topic]: cursor } }),
      );
      return cursor;
    };
    const cursor = await publish(100, 1);
    await eventually(
      async () => ws.messages.find((m) => m.type === 'delta' && m.to === cursor),
      Boolean,
    );
    await eventually(async () => sse.includes(cursor) && sse.includes('"C1":100'), Boolean);
    ws.socket.terminate();
    const next = await publish(90, 2);
    const resumed = await publicWs(
      url2.replace('http', 'ws') + `/ws/publico?topics=${topic}&cursor=${topic}@${cursor}`,
    );
    const recovered = await eventually(
      async () => resumed.messages.find((m) => m.type === 'delta' && m.to === next),
      Boolean,
    );
    assert.equal(recovered?.type === 'delta' && recovered.changes.C1, 90);
    const poll = await (
      await fetch(url1 + `/publico/poll?topics=${topic}&cursor=${topic}@${cursor}`)
    ).json();
    assert.equal(poll.events[0].changes.C1, 90);
    assert.equal(poll.events[0].to, next);

    await Promise.all([first.metrics.publish(), second.metrics.publish()]);
    const metrics = await first.metrics.all();
    const own = metrics.filter((m) => m.instance.startsWith('bc-test-'));
    assert.equal(own.length, 2);
    assert.equal(
      own.reduce((n, m) => n + m.publicConnections, 0),
      2,
    );
    assert.equal(
      own.reduce((n, m) => n + m.verificationConnections, 0),
      2,
    );
    assert.equal(
      own.reduce((n, m) => n + m.connections, 0),
      4,
    );
    const prometheus = await (await fetch(url1 + '/metrics')).text();
    assert.match(prometheus, /public_messages_sent_total/);
    assert.match(prometheus, /votaciones_connections/);
    assert.equal((await a.request({ type: 'heartbeat', active: true }))?.type, 'ack');
  } finally {
    controller.abort();
    await reading;
    for (const socket of sockets) socket.terminate();
    for (const auditor of auditors) auditor.close();
    await first.store.redis.del(keys);
    const owned = await first.store.redis.keys(first.store.key('*'));
    if (owned.length) await first.store.redis.del(owned);
    await first.app.close();
    await second.app.close();
  }
});

test('reiniciar el alimentador público conserva el stream de verificación y los acumulados de mesa', async () => {
  const remaining = new Set([
    'tot:dep',
    'tot:mun:11',
    'tot:pue:176',
    'st:dep',
    'st:mun:11',
    'st:pue:176',
    'st:verif',
    'tot:mesa:42',
  ]);
  const client = {
    async *scanIterator({ MATCH }: { MATCH: string }) {
      const pattern = new RegExp('^' + MATCH.replace('*', '.*') + '$');
      for (const key of remaining) if (pattern.test(key)) yield key;
    },
    async del(key: string) {
      return Number(remaining.delete(key));
    },
  } as unknown as RedisConnection;
  assert.equal(await new FakeActaFeeder(client).reset(), 6);
  assert.deepEqual([...remaining], ['st:verif', 'tot:mesa:42']);
});

test('arranque sin Redis: B queda congelado, C no confirma operaciones y ambos recuperan el servicio', async () => {
  const backend = new URL(config('bc-cold').redisUrl);
  let available = false;
  const connections = new Set<Socket>();
  const gate = createServer((socket) => {
    if (!available) {
      socket.destroy();
      return;
    }
    const remote = connect(Number(backend.port || 6379), backend.hostname);
    connections.add(socket);
    connections.add(remote);
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.on('close', () => {
      connections.delete(socket);
      remote.destroy();
    });
    remote.on('close', () => {
      connections.delete(remote);
      socket.destroy();
    });
    socket.pipe(remote).pipe(socket);
  });
  gate.listen(0, '127.0.0.1');
  await once(gate, 'listening');
  const address = gate.address();
  assert.ok(address && typeof address !== 'string');
  const proxyUrl = new URL(backend);
  proxyUrl.hostname = '127.0.0.1';
  proxyUrl.port = String(address.port);
  let runtime: Awaited<ReturnType<typeof buildApp>> | undefined;
  let auditor: TestClient | undefined;
  try {
    runtime = await buildApp({ ...config('bc-cold'), redisUrl: proxyUrl.toString() });
    const url = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await fetch(url + '/live')).status, 200);
    assert.equal((await fetch(url + '/ready')).status, 503);
    assert.equal((await fetch(url + '/publico/poll?topics=dep')).status, 503);
    await assert.rejects(() => seed(runtime!.store));
    available = true;
    await eventually(
      async () => (await fetch(url + '/ready')).status,
      (s) => s === 200,
      10000,
    );
    await eventually(
      async () => (await fetch(url + '/publico/poll?topics=dep')).status,
      (s) => s === 200,
    );
    const id = await seed(runtime.store);
    auditor = await new TestClient(url.replace('http', 'ws') + '/ws/auditor').ready('demo-ana');
    assert.equal((await auditor.request({ type: 'take', caseId: id }))?.code, 'TAKEN');
  } finally {
    auditor?.close();
    if (runtime) {
      if (runtime.store.redis.isReady) {
        const keys = await runtime.store.redis.keys(runtime.store.key('*'));
        if (keys.length) await runtime.store.redis.del(keys);
      }
      await runtime.app.close();
    }
    for (const socket of connections) socket.destroy();
    gate.close();
    await once(gate, 'close');
  }
});
