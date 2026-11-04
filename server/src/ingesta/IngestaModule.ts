import type { AppModule, ModuleContext } from '../infra/AppModule.js';
import { ConexionRedis } from '../redis/conexion.js';
import { registrarHttpIngesta } from './http.js';
import { ServicioIngesta } from './servicio.js';
import { crearWsJurados } from './ws-jurados.js';

export class IngestaModule implements AppModule {
  readonly name = 'ingesta (Persona A · jurados)';

  private redis: ConexionRedis | null = null;
  private jurados: ReturnType<typeof crearWsJurados> | null = null;

  register(context: ModuleContext): void {
    const redis = new ConexionRedis({
      url: context.config.redisUrl,
      timeoutMs: context.config.number('REDIS_TIMEOUT_MS', 300),
      nombre: `${context.config.instanceId}-ingesta`,
    });
    const ingesta = new ServicioIngesta({
      redis,
      instancia: context.config.instanceId,
      limiteActasPorMinuto: context.config.number('LIMITE_ACTAS_POR_MINUTO', 30),
    });
    registrarHttpIngesta(context.http, { ingesta, redis, instancia: context.config.instanceId });

    const jurados = crearWsJurados({ ingesta, instancia: context.config.instanceId });
    context.upgrades.register(jurados.ruta, (request, socket, head) => {
      jurados.wss.handleUpgrade(request, socket, head, (ws) => jurados.wss.emit('connection', ws, request));
    });
    this.redis = redis;
    this.jurados = jurados;
  }

  async start(): Promise<void> {
    await this.redis?.conectar();
  }

  async stop(): Promise<void> {
    await this.jurados?.cerrar();
    await this.redis?.cerrar();
  }
}
