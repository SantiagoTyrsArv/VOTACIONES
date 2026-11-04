import http from 'k6/http';
import { check, sleep } from 'k6';
if (__ENV.CONFIRM_REAL_MODULES !== 'true')
  throw new Error('Requiere el endpoint de resultados de B.');
export const options = {
  vus: Number(__ENV.CONNECTIONS || 20000),
  duration: __ENV.DURATION || '5m',
};
export default function () {
  const r = http.get(__ENV.POLL_URL);
  check(r, { 'resultado disponible': (r) => r.status === 200 });
  sleep(2);
}
