import type { FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';
import type { AppConfig } from '../config/AppConfig.js';
import type { RedisConnections } from './RedisConnections.js';
import type { RedisHealthMonitor } from './RedisHealthMonitor.js';
import type { UpgradeRouter } from './UpgradeRouter.js';

/** Dependencias que la aplicación entrega a cada módulo. */
export interface ModuleContext {
  readonly config: AppConfig;
  readonly http: FastifyInstance;
  readonly upgrades: UpgradeRouter;
  readonly redis: RedisConnections;
  readonly health: RedisHealthMonitor;
  readonly metrics: Registry;
}

/**
 * Contrato de un módulo funcional. Cada persona es dueña de uno:
 *  - A: IngestaModule      (jurados)
 *  - B: DifusionModule     (público)
 *  - C: VerificacionModule (auditores) + plataforma
 */
export interface AppModule {
  readonly name: string;
  /** Registra rutas HTTP, rutas de upgrade y métricas. No debe abrir conexiones aún. */
  register(context: ModuleContext): Promise<void> | void;
  /** Arranca tareas de fondo (suscripciones, temporizadores) cuando Redis ya conectó. */
  start?(): Promise<void> | void;
  /** Libera recursos al apagar la instancia. */
  stop?(): Promise<void> | void;
}
