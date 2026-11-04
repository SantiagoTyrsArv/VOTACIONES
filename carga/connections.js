import ws from 'k6/ws';
import { check, sleep } from 'k6';
import execution from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const opened = new Counter('c_opened');
const errors = new Counter('c_errors');
const echoLatency = new Trend('c_echo_latency_ms');
const total = Number(__ENV.CONNECTIONS || 20000);
const hold = Number(__ENV.HOLD_SECONDS || 180);
const ramp = Number(__ENV.RAMP_SECONDS || 120);
export const options = {
  scenarios: {
    connections: {
      executor: 'per-vu-iterations',
      vus: total,
      iterations: 1,
      maxDuration: `${ramp + hold + 20}s`,
    },
  },
  thresholds: { checks: ['rate>0.99'], c_errors: ['count==0'], ws_connecting: ['p(95)<5000'] },
};
export default function () {
  const start = execution.scenario.startTime;
  const due = start + ((execution.vu.idInTest - 1) / total) * ramp * 1000;
  if (due > Date.now()) sleep((due - Date.now()) / 1000);
  const response = ws.connect(__ENV.WS_URL || 'ws://127.0.0.1:8080/ws/load', {}, (socket) => {
    socket.on('open', () => {
      opened.add(1);
      errors.add(0);
      socket.send(JSON.stringify({ sentAt: Date.now(), type: 'echo' }));
    });
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.sentAt) echoLatency.add(Date.now() - msg.sentAt);
    });
    socket.setInterval(
      () => socket.send(JSON.stringify({ sentAt: Date.now(), type: 'echo' })),
      10000,
    );
    socket.setTimeout(
      () => socket.close(),
      Math.max(100, start + (ramp + hold) * 1000 - Date.now()),
    );
    socket.on('error', () => errors.add(1));
  });
  check(response, { 'WebSocket upgrade 101': (r) => r && r.status === 101 });
}
