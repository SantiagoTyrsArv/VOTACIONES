import sse from 'k6/x/sse';
import { check } from 'k6';
// Requiere xk6-sse. k6 2.3 puede resolverla automáticamente; necesita red al catálogo.
if (__ENV.CONFIRM_REAL_MODULES !== 'true')
  throw new Error('Falta B real. No usar el eco de C para acreditar SSE público.');
export const options = {
  vus: Number(__ENV.CONNECTIONS || 20000),
  duration: __ENV.DURATION || '5m',
  thresholds: { checks: ['rate>0.99'] },
};
export default function () {
  const response = sse.open(
    __ENV.SSE_URL,
    { headers: { Accept: 'text/event-stream' } },
    (client) => {
      let count = 0;
      client.on('event', (event) => {
        check(event, { 'evento SSE con datos': (e) => Boolean(e.data) });
        if (Number(__ENV.STOP_AFTER_EVENTS || 0) > 0 && ++count >= Number(__ENV.STOP_AFTER_EVENTS))
          client.close();
      });
      client.on('error', () => check(false, { 'SSE sin errores': (v) => v }));
    },
  );
  check(response, { 'SSE HTTP 200': (r) => r && r.status === 200 });
}
