import { hostname } from 'node:os';

const entero = (v: string | undefined, porDefecto: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
};

export interface Config {
  puerto: number;
  host: string;
  redisUrl: string;
  /** Identificador de la réplica (RT-1). Railway lo inyecta en cada réplica. */
  instancia: string;
  /** Timeout por comando de Redis (RF-10). */
  redisTimeoutMs: number;
  /** Actas por minuto por jurado antes de responder LIMITE_EXCEDIDO. */
  limiteActasPorMinuto: number;
}

export function leerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    puerto: entero(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    instancia: env.RAILWAY_REPLICA_ID ?? `${hostname()}-${process.pid}`,
    redisTimeoutMs: entero(env.REDIS_TIMEOUT_MS, 300),
    limiteActasPorMinuto: entero(env.LIMITE_ACTAS_POR_MINUTO, 30),
  };
}
