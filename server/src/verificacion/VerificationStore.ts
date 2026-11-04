import {
  caseInputSchema,
  identifier,
  type CaseInput,
  type CaseRecord,
  type Identity,
  type Presence,
} from '@votaciones/shared';
import type { RedisClient } from '../infra/RedisConnections.js';
import { caseScripts, presenceScript } from './lua.js';
import type { VerificationConfig } from './VerificacionSettings.js';

export type OperationResult = { code: string; token?: string; caseId?: string; receipt?: string };
export type Actor = { identity: Identity; sessionId: string };

export class VerificationStore {
  private blockedUntil = 0;

  constructor(
    readonly config: VerificationConfig,
    readonly redis: RedisClient,
    readonly subscriber: RedisClient,
  ) {}

  key(key: string): string {
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
  }

  async start(onChange: () => void): Promise<void> {
    if (!this.subscriber.isReady) return;
    await this.subscriber.subscribe(this.key('ch:verif'), onChange);
    this.subscriber.on('ready', onChange);
  }

  caseKeys(id: string): string[] {
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
    ].map((key) => this.key(key));
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

  async enqueue(input: CaseInput): Promise<OperationResult> {
    const parsed = caseInputSchema.parse(input);
    if (parsed.source !== 'A' && !(this.config.demo && parsed.source === 'demo')) {
      throw new Error('SOURCE_MISMATCH');
    }
    return this.operation('enqueue', parsed.id, undefined, '', JSON.stringify(parsed));
  }

  async cases(): Promise<CaseRecord[]> {
    return Object.values(await this.run(() => this.redis.hGetAll(this.key('verif:casos'))))
      .map((value) => JSON.parse(value) as CaseRecord)
      .sort((a, b) => b.priority - a.priority || a.receivedAt - b.receivedAt);
  }

  async presence(op: 'connect' | 'beat' | 'leave' | 'sweep', actor?: Actor): Promise<string> {
    const info = actor
      ? { ...actor.identity, sessionId: actor.sessionId, instance: this.config.instance }
      : {};
    return this.run(() =>
      this.redis.eval(presenceScript, {
        keys: ['pres:aud', 'pres:info', 'ch:verif'].map((key) => this.key(key)),
        arguments: [op, actor?.identity.id || '', actor?.sessionId || '', JSON.stringify(info)],
      }),
    ) as Promise<string>;
  }

  async people(): Promise<Presence[]> {
    const values = await this.run(() => this.redis.hGetAll(this.key('pres:info')));
    const now = await this.now();
    return Object.values(values)
      .map((value) => JSON.parse(value) as Presence)
      .filter((person) => now - person.lastSeen <= 30_000);
  }

  async now(): Promise<number> {
    const time = (await this.run(() => this.redis.sendCommand(['TIME']))) as string[];
    return Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
  }

  async sweep(): Promise<{ recovered: number; ghosts: number }> {
    const now = await this.now();
    const ids = await this.run(() =>
      this.redis.zRangeByScore(this.key('verif:asignados'), '-inf', now, {
        LIMIT: { offset: 0, count: 500 },
      }),
    );
    let recovered = 0;
    for (const id of ids) {
      if ((await this.operation('sweep', id)).code === 'RECOVERED') recovered++;
    }
    const ghosts = Number(await this.presence('sweep'));
    return { recovered, ghosts };
  }
}
