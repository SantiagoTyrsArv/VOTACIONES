import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
const dockerBin = process.env.DOCKER_BIN;
if (!dockerBin || !isAbsolute(dockerBin)) throw new Error('Configure DOCKER_BIN con la ruta absoluta de Docker');
mkdirSync('carga/results', { recursive: true });
const points = ['0', '1/4', '1/2', '3/4', '1'];
const total = Number(process.env.CONNECTIONS || 16);
assert.ok(total % 4 === 0, 'CONNECTIONS debe ser múltiplo de 4');
await Promise.all(
  Array.from(
    { length: 4 },
    (_, index) =>
      new Promise((res, rej) => {
        const args = [
          'run',
          '--rm',
          '-v',
          `${resolve('carga')}:/scripts`,
          'grafana/k6:2.3.0',
          'run',
          '--quiet',
          '--execution-segment',
          `${points[index]}:${points[index + 1]}`,
          '--execution-segment-sequence',
          points.join(','),
          '-e',
          `CONNECTIONS=${total}`,
          '-e',
          `RAMP_SECONDS=${process.env.RAMP_SECONDS || 2}`,
          '-e',
          `HOLD_SECONDS=${process.env.HOLD_SECONDS || 3}`,
          '-e',
          `WS_URL=${process.env.WS_URL || 'ws://host.docker.internal:8080/ws/load'}`,
          '--summary-export',
          `/scripts/results/segment-${index}.json`,
          '/scripts/connections.js',
        ];
        const child = spawn(dockerBin, args, { stdio: 'inherit' });
        child.on('error', rej);
        child.on('exit', (code) =>
          code === 0 ? res() : rej(new Error(`Generador ${index}: ${code}`)),
        );
      }),
  ),
);
const counts = Array.from(
  { length: 4 },
  (_, i) =>
    JSON.parse(readFileSync(`carga/results/segment-${i}.json`, 'utf8')).metrics.c_opened.count,
);
assert.deepEqual(counts, Array(4).fill(total / 4));
console.log(JSON.stringify({ total: counts.reduce((a, b) => a + b, 0), perGenerator: counts }));
