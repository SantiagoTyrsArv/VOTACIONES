import { createClient } from 'redis';
import {
  caseInputSchema,
  identifier,
  type CaseInput,
  type CaseRecord,
  type Identity,
  type Presence,
} from '../shared/contracts.js';
import { caseScripts, presenceScript } from './lua.js';
import type { Config } from './config.js';

export type RedisConnection = ReturnType<typeof createClient>;
export type OperationResult = { code: string; token?: string; caseId?: string; receipt?: string };
export type Actor = { identity: Identity; sessionId: string };
export class VerificationStore {
  readonly redis: RedisConnection;
  readonly subscriber: RedisConnection;
  private blockedUntil = 0;
  constructor(readonly config: Config) {
    this.redis = createClient({
      url: config.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      commandOptions: { timeout: 300 },
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: (retries) => Math.min(100 * (retries + 1), 2000),
      },
    });
    this.subscriber = this.redis.duplicate();
    this.redis.on('error', () => {});
    this.subscriber.on('error', () => {});
  }
  key(key: string) {
    return `${this.config.keyPrefix}${key}`;
  }
  async run<T>(operation: () => Promise<T>, probe = false): Promise<T> {
    if (!probe && Date.now() < this.blockedUntil) throw new Error('REDIS_CIRCUIT_OPEN');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.blockedUntil = Date.now() + 1000;
            reject(new Error('REDIS_TIMEOUT'));
          }, 300);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Un comando ya enviado puede terminar después del timeout. Se devuelve incertidumbre,
    // nunca una confirmación, y el cliente recupera la fotografía antes de decidir.
  }
  async open(onChange: () => void) {
    await this.redis.connect();
    await this.subscriber.connect();
    await this.subscriber.subscribe(this.key('ch:verif'), onChange);
    // Pub/Sub solo avisa; la fotografía en Redis siempre es la fuente de verdad.
    this.subscriber.on('ready', onChange);
  }
  async close() {
    await Promise.all(
      [this.redis, this.subscriber].map(async (client) => {
        if (client.isOpen) client.destroy();
      }),
    );
  }
  caseKeys(id: string) {
    identifier.parse(id);
    return [
      'verif:casos',
      'verif:cola',
      'verif:asignados',
      `lock:caso:${id}`,
      `fence:caso:${id}`,
      'st:verif',
      'ch:verif',
      'pres:aud',
      'pres:info',
    ].map((k) => this.key(k));
  }
  async operation(
    op: keyof typeof caseScripts,
    id: string,
    actor?: Actor,
    token = '',
    extra = '',
  ): Promise<OperationResult> {
    return JSON.parse(
      (await this.run(() =>
        this.redis.eval(caseScripts[op], {
          keys: this.caseKeys(id),
          arguments: [id, actor?.identity.id || '', actor?.sessionId || '', token, extra],
        }),
      )) as string,
    ) as OperationResult;
  }
  async enqueue(input: CaseInput) {
    const parsed = caseInputSchema.parse(input);
    if (parsed.source !== (this.config.demo ? 'demo' : 'A')) throw new Error('SOURCE_MISMATCH');
    return this.operation('enqueue', parsed.id, undefined, '', JSON.stringify(parsed));
  }
  async cases(): Promise<CaseRecord[]> {
    return Object.values(await this.run(() => this.redis.hGetAll(this.key('verif:casos'))))
      .map((v) => JSON.parse(v) as CaseRecord)
      .sort((a, b) => b.priority - a.priority || a.receivedAt - b.receivedAt);
  }
  async presence(op: 'connect' | 'beat' | 'leave' | 'sweep', actor?: Actor) {
    const info = actor
      ? { ...actor.identity, sessionId: actor.sessionId, instance: this.config.instance }
      : {};
    return this.run(() =>
      this.redis.eval(presenceScript, {
        keys: ['pres:aud', 'pres:info', 'ch:verif'].map((k) => this.key(k)),
        arguments: [op, actor?.identity.id || '', actor?.sessionId || '', JSON.stringify(info)],
      }),
    ) as Promise<string>;
  }
  async people(): Promise<Presence[]> {
    const values = await this.run(() => this.redis.hGetAll(this.key('pres:info')));
    const now = await this.now();
    return Object.values(values)
      .map((v) => JSON.parse(v) as Presence)
      .filter((p) => now - p.lastSeen <= 30_000);
  }
  async now() {
    const time = (await this.run(() => this.redis.sendCommand(['TIME']))) as string[];
    return Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
  }
  async sweep() {
    const now = await this.now();
    const ids = await this.run(() =>
      this.redis.zRangeByScore(this.key('verif:asignados'), '-inf', now, {
        LIMIT: { offset: 0, count: 500 },
      }),
    );
    let recovered = 0;
    for (const id of ids) if ((await this.operation('sweep', id)).code === 'RECOVERED') recovered++;
    const ghosts = Number(await this.presence('sweep'));
    return { recovered, ghosts };
  }
}
