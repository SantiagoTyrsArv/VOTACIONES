import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Config } from '../server/config.js';
import type { ServerMessage } from '../shared/contracts.js';
import type { Actor, VerificationStore } from '../server/store.js';
export const testPrefix = `test-c:${randomUUID()}:`;
export const config = (instance: string): Config => ({
  redisUrl: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380',
  instance,
  port: 0,
  host: '127.0.0.1',
  demo: true,
  keyPrefix: testPrefix,
  log: false,
  allowedOrigins: [],
  credentials: {
    'demo-ana': { id: 'ana', name: 'Ana Torres', role: 'auditor' },
    'demo-luis': { id: 'luis', name: 'Luis Rojas', role: 'auditor' },
    'demo-coord': { id: 'coordinacion', name: 'Coordinación', role: 'coordinator' },
  },
});
export async function actor(
  store: VerificationStore,
  id: string = randomUUID(),
  role: 'auditor' | 'coordinator' = 'auditor',
): Promise<Actor> {
  const result: Actor = { identity: { id, name: id, role }, sessionId: randomUUID() };
  await store.presence('connect', result);
  return result;
}
export async function seed(store: VerificationStore, id: string = randomUUID()) {
  await store.enqueue({
    id,
    version: 1,
    mesa: '03',
    municipality: 'Pasto',
    reason: 'Descuadre contable',
    priority: 90,
    receivedAt: Date.now(),
    votes: { c1: 120, c2: 140 },
    source: 'demo',
  });
  return id;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function eventually<T>(
  fn: () => Promise<T>,
  accept: (v: T) => boolean,
  timeout = 6000,
): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do {
    last = await fn();
    if (accept(last)) return last;
    await sleep(50);
  } while (Date.now() < end);
  throw new Error(`Condición no alcanzada: ${JSON.stringify(last!)}`);
}
export class TestClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw) =>
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage),
    );
  }
  async ready(credential: string) {
    await new Promise<void>((res, rej) => {
      this.socket.once('open', () => res());
      this.socket.once('error', rej);
    });
    this.socket.send(JSON.stringify({ type: 'auth', requestId: randomUUID(), credential }));
    await eventually(
      async () => this.messages.some((m) => m.type === 'snapshot'),
      (v) => v,
    );
    return this;
  }
  async request(data: Record<string, unknown>) {
    const requestId = randomUUID();
    this.socket.send(JSON.stringify({ ...data, requestId }));
    return eventually(
      async () => this.messages.find((m) => m.requestId === requestId),
      (v) => Boolean(v),
    );
  }
  close() {
    this.socket.terminate();
  }
}
