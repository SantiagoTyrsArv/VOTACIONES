import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { identitySchema, type Identity } from '../shared/contracts.js';

export type Config = {
  redisUrl: string;
  instance: string;
  port: number;
  host: string;
  demo: boolean;
  credentials: Record<string, Identity>;
  integrationToken?: string;
  allowedOrigins: string[];
  keyPrefix: string;
  log: boolean;
};
export function readConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const demo = process.env.DEMO_MODE === 'true';
  const raw = JSON.parse(process.env.AUDITOR_CREDENTIALS_JSON || '{}') as Record<string, unknown>;
  const credentials: Record<string, Identity> = Object.fromEntries(
    Object.entries(raw).map(([token, identity]) => {
      if (token.length < 24)
        throw new Error('Las credenciales reales deben tener al menos 24 caracteres');
      return [token, identitySchema.parse(identity)];
    }),
  );
  if (demo)
    Object.assign(credentials, {
      'demo-ana': { id: 'ana', name: 'Ana Torres', role: 'auditor' },
      'demo-luis': { id: 'luis', name: 'Luis Rojas', role: 'auditor' },
      'demo-coord': { id: 'coordinacion', name: 'Coordinación', role: 'coordinator' },
    });
  if (!Object.keys(credentials).length)
    throw new Error('Configure AUDITOR_CREDENTIALS_JSON o habilite DEMO_MODE=true para pruebas');
  return {
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    instance:
      process.env.RAILWAY_REPLICA_ID || process.env.INSTANCE_ID || `c-${randomUUID().slice(0, 8)}`,
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    demo,
    credentials,
    integrationToken: process.env.INTEGRATION_TOKEN,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
    keyPrefix: demo ? 'demo:' : '',
    log: process.env.NODE_ENV !== 'test',
  };
}
