import assert from 'node:assert/strict';
import { TestClient } from '../tests/helpers.js';
const base = process.env.BASE_URL || 'http://127.0.0.1:8080';
const seen = new Set<string>();
for (let i = 0; i < 20; i++) {
  const response = await fetch(base + '/whoami', { headers: { Connection: 'close' } });
  assert.equal(response.status, 200);
  seen.add((await response.json()).instance);
}
assert.ok(seen.size >= 2, 'El balanceador debe alcanzar al menos dos réplicas');
const a = await new TestClient(base.replace('http', 'ws') + '/ws/auditors').ready('demo-ana');
const b = await new TestClient(base.replace('http', 'ws') + '/ws/auditors').ready('demo-luis');
try {
  const snap = a.messages.find((m) => m.snapshot)?.snapshot;
  const item = snap?.cases.find((c) => c.status === 'pending');
  assert.ok(item, 'Ejecute la semilla y libere un caso para probar');
  const results = await Promise.all([
    a.request({ type: 'take', caseId: item.id }),
    b.request({ type: 'take', caseId: item.id }),
  ]);
  assert.deepEqual(results.map((r) => r?.code).sort(), ['BUSY', 'TAKEN']);
  const winner = results[0]?.code === 'TAKEN' ? a : b,
    token = results.find((r) => r?.code === 'TAKEN')!.token!;
  assert.equal(
    (
      await winner.request({
        type: 'resolve',
        caseId: item.id,
        token,
        resolution: { action: 'approve', note: 'Prueba de humo de C' },
      })
    )?.code,
    'PENDING_A',
  );
  assert.equal(
    (await winner.request({ type: 'release', caseId: item.id, token }))?.code,
    'RELEASED',
  );
  console.log(
    JSON.stringify({
      replicas: [...seen],
      case: item.id,
      take: results.map((r) => r?.code),
      resolution: 'PENDING_A',
      release: 'RELEASED',
    }),
  );
} finally {
  a.close();
  b.close();
}
