import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { PendingAAdapter, caseFromActa } from '../server/integration.js';
import { actor, config, eventually, seed, sleep, TestClient, testPrefix } from './helpers.js';
import { clientMessageSchema, IDLE_STOP_MS, IDLE_WARNING_MS } from '../shared/contracts.js';
let first: Awaited<ReturnType<typeof buildApp>>, second: typeof first;
let url1: string, url2: string;
before(async () => {
  first = await buildApp(config('c-test-1'));
  second = await buildApp(config('c-test-2'));
  url1 = await first.app.listen({ host: '127.0.0.1', port: 0 });
  url2 = await second.app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => {
  if (first) {
    const keys = await first.store.redis.keys(`${testPrefix}*`);
    if (keys.length) await first.store.redis.del(keys);
    await first.app.close();
  }
  if (second) await second.app.close();
});
test('dos instancias: una sola toma gana y el token es global', async () => {
  const id = await seed(first.store),
    a = await actor(first.store),
    b = await actor(second.store);
  const results = await Promise.all([
    first.store.operation('take', id, a),
    second.store.operation('take', id, b),
  ]);
  assert.deepEqual(results.map((r) => r.code).sort(), ['BUSY', 'TAKEN']);
  assert.equal(await first.store.redis.zScore(first.store.key('verif:cola'), id), null);
  assert.equal(await second.store.redis.get(second.store.key(`fence:caso:${id}`)), '1');
});
test('renovación: extiende a 30 s y rechaza dueño o token distintos', async () => {
  const id = await seed(first.store),
    a = await actor(first.store),
    b = await actor(second.store);
  const taken = await first.store.operation('take', id, a);
  const lock = first.store.key(`lock:caso:${id}`);
  await first.store.redis.pExpire(lock, 5000);
  assert.equal((await second.store.operation('renew', id, b, taken.token)).code, 'STALE_TOKEN');
  assert.equal((await second.store.operation('renew', id, a, '999')).code, 'STALE_TOKEN');
  assert.equal((await second.store.operation('renew', id, a, taken.token)).code, 'RENEWED');
  const ttl = await first.store.redis.pTTL(lock);
  assert.ok(ttl > 29000 && ttl <= 30000);
});
test('liberación tardía y resolución obsoleta no afectan al nuevo dueño', async () => {
  const id = await seed(first.store),
    a = await actor(first.store),
    b = await actor(second.store);
  const old = await first.store.operation('take', id, a);
  await first.store.redis.pExpire(first.store.key(`lock:caso:${id}`), 1);
  await sleep(15);
  assert.equal((await second.store.operation('sweep', id)).code, 'RECOVERED');
  const current = await second.store.operation('take', id, b);
  assert.equal(current.token, '2');
  assert.equal((await first.store.operation('release', id, a, old.token)).code, 'STALE_TOKEN');
  const adapter = new PendingAAdapter();
  assert.equal(
    (
      await adapter.apply(first.store, {
        caseId: id,
        token: old.token!,
        actor: a,
        resolution: { action: 'approve', note: 'Revisión tardía' },
      })
    ).code,
    'STALE_TOKEN',
  );
  assert.equal(
    await first.store.redis.get(first.store.key(`lock:caso:${id}`)),
    `${b.identity.id}:2`,
  );
  assert.equal(
    (
      await adapter.apply(second.store, {
        caseId: id,
        token: current.token!,
        actor: b,
        resolution: { action: 'approve', note: 'Acta revisada' },
      })
    ).code,
    'PENDING_A',
  );
  const record = (await first.store.cases()).find((c) => c.id === id)!;
  assert.equal(record.status, 'assigned');
  assert.equal(record.appliedReceipt, undefined);
  assert.deepEqual(record.votes, { c1: 120, c2: 140 });
});
test('presencia: reconexión invalida sesión anterior y un cierre tardío no borra la nueva', async () => {
  const a = await actor(first.store),
    id = await seed(first.store),
    take = await first.store.operation('take', id, a);
  const reconnected = await actor(second.store, a.identity.id);
  assert.equal(await first.store.presence('beat', a), 'SESSION_REPLACED');
  assert.equal(await first.store.presence('leave', a), 'UNCHANGED');
  assert.equal(
    (await second.store.operation('resume', id, reconnected, take.token)).code,
    'RESUMED',
  );
  assert.equal((await first.store.operation('release', id, a, take.token)).code, 'STALE_TOKEN');
  assert.equal(
    (await second.store.operation('renew', id, reconnected, take.token)).code,
    'RENEWED',
  );
  assert.equal(
    (await second.store.people()).find((p) => p.id === a.identity.id)?.instance,
    'c-test-2',
  );
});
test('inactividad: a los 10 minutos no renueva; constantes de aviso a los 8', async () => {
  assert.equal(IDLE_WARNING_MS, 480000);
  assert.equal(IDLE_STOP_MS, 600000);
  const a = await actor(first.store),
    id = await seed(first.store),
    take = await first.store.operation('take', id, a);
  const record = (await first.store.cases()).find((c) => c.id === id)!;
  record.lastActivity = (await first.store.now()) - 600001;
  await first.store.redis.hSet(first.store.key('verif:casos'), id, JSON.stringify(record));
  const ttl = await first.store.redis.pTTL(first.store.key(`lock:caso:${id}`));
  assert.equal((await first.store.operation('renew', id, a, take.token, '0')).code, 'INACTIVE');
  assert.ok((await first.store.redis.pTTL(first.store.key(`lock:caso:${id}`))) <= ttl);
});
test('barridos concurrentes: una devolución por caso, sin pérdidas ni duplicados', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = await seed(first.store),
      a = await actor(first.store);
    ids.push(id);
    await first.store.operation('take', id, a);
    await first.store.redis.pExpire(first.store.key(`lock:caso:${id}`), 1);
    await first.store.redis.zAdd(first.store.key('verif:asignados'), { score: 0, value: id });
  }
  await sleep(20);
  await Promise.all([first.store.sweep(), second.store.sweep(), first.store.sweep()]);
  const entries = await first.store.redis.xRange(first.store.key('st:verif'), '-', '+');
  for (const id of ids) {
    assert.equal((await second.store.cases()).find((c) => c.id === id)?.status, 'pending');
    assert.notEqual(await first.store.redis.zScore(first.store.key('verif:cola'), id), null);
    assert.equal(
      entries.filter((e) => e.message.type === 'recovered' && e.message.caseId === id).length,
      1,
    );
  }
});
test('validación antes de escribir: Redis con tipo incorrecto no deja medio bloqueo', async () => {
  const id = await seed(first.store),
    a = await actor(first.store),
    stream = first.store.key('st:verif');
  await first.store.redis.rename(stream, `${stream}:saved`);
  await first.store.redis.set(stream, 'incorrecto');
  try {
    await assert.rejects(first.store.operation('take', id, a), /WRONGTYPE/);
    assert.equal(await first.store.redis.get(first.store.key(`lock:caso:${id}`)), null);
    assert.equal(await first.store.redis.get(first.store.key(`fence:caso:${id}`)), null);
    assert.equal((await first.store.cases()).find((c) => c.id === id)?.status, 'pending');
  } finally {
    await first.store.redis.del(stream);
    await first.store.redis.rename(`${stream}:saved`, stream);
  }
});
test('validación de mensajes y permisos del coordinador', async () => {
  assert.equal(
    clientMessageSchema.safeParse({ type: 'release', requestId: 'x', caseId: '../x', token: '1' })
      .success,
    false,
  );
  assert.equal(
    clientMessageSchema.safeParse({
      type: 'resolve',
      requestId: 'x',
      caseId: 'c1',
      token: '1',
      resolution: { action: 'correct', note: 'Revisada' },
    }).success,
    false,
  );
  const id = await seed(first.store),
    coordinator = await actor(first.store, undefined, 'coordinator');
  assert.equal((await first.store.operation('take', id, coordinator)).code, 'FORBIDDEN');
});
test('un caso malformado se rechaza antes de modificar la cola o el bloqueo', async () => {
  const id = await seed(first.store),
    a = await actor(first.store);
  const key = first.store.key('verif:casos'),
    saved = (await first.store.redis.hGet(key, id))!;
  const corrupt = JSON.parse(saved) as Record<string, unknown>;
  delete corrupt.priority;
  await first.store.redis.hSet(key, id, JSON.stringify(corrupt));
  try {
    await assert.rejects(first.store.operation('take', id, a), /INVALID_CASE_RECORD/);
    assert.equal(await first.store.redis.get(first.store.key(`lock:caso:${id}`)), null);
    assert.notEqual(await first.store.redis.zScore(first.store.key('verif:cola'), id), null);
  } finally {
    await first.store.redis.hSet(key, id, saved);
  }
});
test('entrada de A: idempotencia, conflictos y separación del modo demo', async () => {
  const realConfig = {
    ...config('c-real-contract'),
    demo: false,
    integrationToken: 'test-integration-secret',
    keyPrefix: `${testPrefix}real:`,
  };
  const real = await buildApp(realConfig);
  const input = caseFromActa(
    {
      acta: 'acta-A-1',
      version: 1,
      mesa: 3,
      puesto: 42,
      municipio: 11,
      jurado: 'jurado-1',
      ts_cierre: 100,
      votos: { c1: 1, c2: 2 },
      sufragantes: 3,
      hash_foto: '0'.repeat(64),
      idem: 'test-acta-A-1',
    },
    'Descuadre',
    90,
    100,
  );
  const post = (body: unknown) =>
    real.app.inject({
      method: 'POST',
      url: '/api/integration/cases',
      headers: { authorization: 'Bearer test-integration-secret' },
      payload: body as Record<string, unknown>,
    });
  try {
    assert.equal((await post(input)).json().code, 'QUEUED');
    assert.equal((await post({ ...input, votes: { c2: 2, c1: 1 } })).json().code, 'EXISTS');
    assert.equal((await post({ ...input, mesa: 'otra' })).statusCode, 409);
    assert.equal((await post({ ...input, votes: { c1: 3, c2: 2 } })).statusCode, 409);
    assert.equal((await post({ ...input, source: 'demo' })).statusCode, 400);
    assert.equal((await post({ ...input, id: 'invalid/path' })).statusCode, 400);
    assert.equal((await real.app.inject('/ws/load')).statusCode, 404);
    assert.equal((await real.store.cases()).length, 1);
    assert.equal(
      (await first.store.cases()).some((c) => c.id === input.id),
      false,
    );
  } finally {
    await real.app.close();
  }
});
test('WebSocket real: dos réplicas, avisos, resolución pendiente y reconexión', async () => {
  const id = await seed(first.store),
    a = await new TestClient(url1.replace('http', 'ws') + '/ws/auditors').ready('demo-ana');
  const b = await new TestClient(url2.replace('http', 'ws') + '/ws/auditors').ready('demo-luis');
  let again: TestClient | undefined;
  try {
    const r = await Promise.all([
      a.request({ type: 'take', caseId: id }),
      b.request({ type: 'take', caseId: id }),
    ]);
    assert.deepEqual(r.map((v) => v?.code).sort(), ['BUSY', 'TAKEN']);
    const winner = r[0]?.code === 'TAKEN' ? a : b,
      token = r.find((v) => v?.code === 'TAKEN')!.token!;
    assert.equal(
      (
        await winner.request({
          type: 'resolve',
          caseId: id,
          token,
          resolution: { action: 'approve', note: 'Revisado con acta física' },
        })
      )?.code,
      'PENDING_A',
    );
    const credential = winner === a ? 'demo-ana' : 'demo-luis',
      identity = winner === a ? 'ana' : 'luis';
    winner.close();
    await eventually(
      () => first.store.people(),
      (p) => !p.some((v) => v.id === identity),
    );
    again = await new TestClient(url1.replace('http', 'ws') + '/ws/auditors').ready(credential);
    assert.equal((await again.request({ type: 'heartbeat', active: true }))?.code, 'RENEWED');
    assert.equal((await again.request({ type: 'release', caseId: id, token }))?.code, 'RELEASED');
    assert.ok(b.messages.some((m) => m.type === 'changed'));
  } finally {
    a.close();
    b.close();
    again?.close();
  }
});
test('HTTP y métricas: dos instancias identificables, datos reales y métricas A/B ausentes', async () => {
  for (const [url, instance] of [
    [url1, 'c-test-1'],
    [url2, 'c-test-2'],
  ] as const) {
    assert.equal((await fetch(url + '/live')).status, 200);
    assert.equal((await fetch(url + '/ready')).status, 200);
    assert.equal((await (await fetch(url + '/whoami')).json()).instance, instance);
  }
  assert.equal((await fetch(url1 + '/api/state')).status, 401);
  assert.equal(
    (await fetch(url1 + '/api/metrics', { headers: { Authorization: 'Bearer demo-ana' } })).status,
    403,
  );
  await Promise.all([first.metrics.publish(), second.metrics.publish()]);
  const result = await (
    await fetch(url1 + '/api/metrics', { headers: { Authorization: 'Bearer demo-coord' } })
  ).json();
  assert.equal(result.instances.length, 2);
  for (const value of result.instances) {
    assert.ok(value.rssBytes > 0);
    assert.equal(value.acceptedActasPerMinute, null);
    assert.equal(value.publicLatencyP95Ms, null);
  }
  assert.match(
    await (
      await fetch(url2 + '/metrics', { headers: { Authorization: 'Bearer demo-coord' } })
    ).text(),
    /votaciones_connections\{instance="c-test-2"\}/,
  );
  assert.equal(
    (
      await fetch(url1 + '/api/integration/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
});
test('Redis sin respuesta: /ready devuelve 503 en plazo y /live sigue en 200', async () => {
  await first.store.redis.sendCommand(['CLIENT', 'PAUSE', '800', 'ALL']);
  const started = Date.now();
  const [ready, live] = await Promise.all([fetch(url1 + '/ready'), fetch(url2 + '/live')]);
  assert.equal(ready.status, 503);
  assert.equal(live.status, 200);
  assert.ok(Date.now() - started < 1000);
  await sleep(1600);
  assert.equal((await fetch(url1 + '/ready')).status, 200);
});
test('expiración REAL de 30 s: el barrido de 5 s recupera el caso y elimina presencia fantasma', async () => {
  const id = await seed(first.store),
    a = await actor(first.store);
  await first.store.operation('take', id, a);
  const started = Date.now();
  await sleep(30100);
  await eventually(
    () => first.store.cases(),
    (v) => v.find((c) => c.id === id)?.status === 'pending',
    6000,
  );
  await eventually(
    () => first.store.people(),
    (v) => !v.some((p) => p.id === a.identity.id),
    6000,
  );
  assert.equal(await first.store.redis.get(first.store.key(`lock:caso:${id}`)), null);
  assert.ok(Date.now() - started < 36500);
});
