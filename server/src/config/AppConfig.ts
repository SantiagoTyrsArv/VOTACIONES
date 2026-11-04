import { hostname } from 'node:os';

/**
 * Configuración de la instancia leída de variables de entorno.
 * La única dependencia compartida entre instancias es REDIS_URL (RT-3).
 */
export class AppConfig {
  private constructor(
    readonly port: number,
    readonly redisUrl: string,
    readonly instanceId: string,
    readonly logLevel: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const instanceId = env.RAILWAY_REPLICA_ID ?? env.INSTANCE_ID ?? `${hostname()}-${process.pid}`;
    return new AppConfig(
      Number(env.PORT ?? 3000),
      env.REDIS_URL ?? 'redis://localhost:6379',
      instanceId,
      env.LOG_LEVEL ?? 'info',
      env,
    );
  }

  /** Lectura tipada de parámetros opcionales de cada módulo. */
  number(name: string, fallback: number): number {
    const raw = this.env[name];
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  string(name: string, fallback: string): string {
    return this.env[name] ?? fallback;
  }

  flag(name: string, fallback: boolean): boolean {
    const raw = this.env[name];
    if (raw === undefined) return fallback;
    return raw === '1' || raw.toLowerCase() === 'true';
  }
}
