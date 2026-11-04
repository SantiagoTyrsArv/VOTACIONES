import http from 'k6/http';
import { check, sleep } from 'k6';
import execution from 'k6/execution';
import { SharedArray } from 'k6/data';
const events = new SharedArray('jornada', () => JSON.parse(open('./profile.json')).events);
if (__ENV.CONFIRM_REAL_MODULES !== 'true')
  throw new Error(
    'Requiere A real. Revise el contrato y use CONFIRM_REAL_MODULES=true. C no implementa POST /actas.',
  );
const speed = Number(__ENV.SPEED || 1);
export const options = {
  scenarios: {
    jornada: {
      executor: 'shared-iterations',
      vus: 300,
      iterations: events.length,
      maxDuration: `${Math.ceil(7800 / speed)}s`,
    },
  },
  thresholds: { checks: ['rate>0.99'], http_req_failed: ['rate<0.01'] },
};
export default function () {
  const event = events[execution.scenario.iterationInTest];
  if (!event) return;
  const due = execution.scenario.startTime + event.offsetMs / speed;
  const wait = (due - Date.now()) / 1000;
  if (wait > 0) sleep(wait);
  // Adaptar aquí el formato cuando A apruebe shared/. idem se reutiliza en los reenvíos.
  const response = http.post(`${__ENV.API_URL}/actas`, JSON.stringify(event.payload), {
    headers: {
      'Content-Type': 'application/json',
      ...(__ENV.INGEST_TOKEN ? { Authorization: `Bearer ${__ENV.INGEST_TOKEN}` } : {}),
    },
    tags: { kind: event.kind },
  });
  check(response, { 'A confirma registro o reenvío': (r) => r.status >= 200 && r.status < 300 });
}
