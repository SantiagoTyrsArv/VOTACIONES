import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createClient } from 'redis';
import { TestClient, eventually } from '../tests/helpers.js';

const dockerBin = process.env.DOCKER_BIN;
if (!dockerBin || !isAbsolute(dockerBin)) throw new Error('Configure DOCKER_BIN con la ruta absoluta de Docker');
// Solo actúa sobre el proyecto Compose local votaciones-c, con datos demo.
const docker = (...args: string[]) =>
  execFileSync(dockerBin, ['compose', ...args], { stdio: 'pipe' });
const redis = createClient({ url: 'redis://127.0.0.1:6379' });
await redis.connect();
const a = await new TestClient('ws://127.0.0.1:8081/ws/auditors').ready('demo-ana');
const b = await new TestClient('ws://127.0.0.1:8082/ws/auditors').ready('demo-luis');
const keepB = setInterval(() => {
  if (b.socket.readyState === 1)
    b.socket.send(
      JSON.stringify({ type: 'heartbeat', requestId: `hb-${Date.now()}`, active: false }),
    );
}, 10000);
const result: Record<string, unknown> = {
  date: new Date().toISOString(),
  scope: 'Docker local, C, datos demo',
};
let paused = false;
try {
  const item = a.messages
    .find((m) => m.snapshot)
    ?.snapshot?.cases.find((c) => c.status === 'pending');
  assert.ok(item);
  const take = await a.request({ type: 'take', caseId: item.id });
  assert.equal(take?.code, 'TAKEN');
  const started = Date.now();
  docker('kill', '--signal', 'SIGKILL', 'app1');
  await eventually(
    async () => a.socket.readyState,
    (state) => state === 3,
  );
  await eventually(
    async () => JSON.parse((await redis.hGet('demo:verif:casos', item.id))!),
    (c) => c.status === 'pending',
    37000,
  );
  result.recoveredAfterInstanceKillMs = Date.now() - started;
  const reassigned = await b.request({ type: 'take', caseId: item.id });
  assert.equal(reassigned?.code, 'TAKEN');
  assert.ok(BigInt(reassigned!.token!) > BigInt(take!.token!));
  assert.equal(
    (await b.request({ type: 'release', caseId: item.id, token: reassigned!.token }))?.code,
    'RELEASED',
  );
  execFileSync(dockerBin, ['start', 'votaciones-c-app1-1'], { stdio: 'pipe' });
  const ready = async () =>
    Promise.all(
      [8081, 8082].map(async (port) => {
        try {
          return (
            await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(2000) })
          ).status;
        } catch {
          return 0;
        }
      }),
    );
  await eventually(ready, (status) => status.every((s) => s === 200), 15000);
  docker('pause', 'redis');
  paused = true;
  result.readyDuringRedisPause = await ready();
  assert.deepEqual(result.readyDuringRedisPause, [503, 503]);
  result.liveDuringRedisPause = await Promise.all(
    [8081, 8082].map(async (port) => (await fetch(`http://127.0.0.1:${port}/live`)).status),
  );
  assert.deepEqual(result.liveDuringRedisPause, [200, 200]);
  docker('unpause', 'redis');
  paused = false;
  await eventually(ready, (status) => status.every((s) => s === 200), 15000);
  const fenceKey = `demo:fence:caso:${item.id}`,
    before = await redis.get(fenceKey);
  await redis.close();
  docker('restart', 'redis');
  await eventually(ready, (status) => status.every((s) => s === 200), 15000);
  await redis.connect();
  const after = await redis.get(fenceKey);
  assert.equal(after, before);
  assert.ok(await redis.hGet('demo:verif:casos', item.id));
  result.aofOrderedRestart = { caseId: item.id, fenceBefore: before, fenceAfter: after };
  writeFileSync('docs/evidence/chaos.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (paused) docker('unpause', 'redis');
  execFileSync(dockerBin, ['start', 'votaciones-c-app1-1'], { stdio: 'pipe' });
  clearInterval(keepB);
  a.close();
  b.close();
  if (redis.isOpen) redis.destroy();
}
