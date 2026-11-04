import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppModule, ModuleContext } from '../infra/AppModule.js';
import { registerStaticFiles } from '../infra/StaticFiles.js';
import { ConexionRedis } from '../redis/conexion.js';
import { AutenticadorJurados } from './autenticacion.js';
import { registrarHttpIngesta } from './http.js';
import { ResolucionAtomica } from './resolucion.js';
import { ServicioIngesta } from './servicio.js';
import { crearWsJurados, recordarJurado } from './ws-jurados.js';

export class IngestaModule implements AppModule {
  readonly name = 'ingesta (Persona A · jurados)';

  private redis: ConexionRedis | null = null;
  private jurados: ReturnType<typeof crearWsJurados> | null = null;

  /** Adaptador que C usa para aplicar resoluciones de auditores con el Lua de A. */
  readonly resolucion: ResolucionAtomica;

  constructor(instancia = process.env.RAILWAY_REPLICA_ID ?? process.env.INSTANCE_ID ?? 'local') {
    this.resolucion = new ResolucionAtomica({ redis: () => this.redis, instancia });
  }

  async register(context: ModuleContext): Promise<void> {
    const autenticador = new AutenticadorJurados(context.config.string('JURADO_SECRETO', '') || undefined);
    if (!autenticador.activo) {
      context.http.log.warn('JURADO_SECRETO no definido: la ingesta acepta actas sin credencial (solo desarrollo)');
    }
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
    await registrarHttpIngesta(context.http, { ingesta, redis, instancia: context.config.instanceId, autenticador });

    const jurados = crearWsJurados({ ingesta, instancia: context.config.instanceId });
    context.upgrades.register(jurados.ruta, (request, socket, head) => {
      // Se rechaza antes del upgrade: un socket sin credencial válida nunca se abre.
      const auth = autenticador.autenticarUrl(request.url);
      if (!auth.ok) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      recordarJurado(request, auth.jurado);
      jurados.wss.handleUpgrade(request, socket, head, (ws) => jurados.wss.emit('connection', ws, request));
    });
    this.servirPwa(context);
    this.redis = redis;
    this.jurados = jurados;
  }

  /** La PWA compilada (npm run build -w @preconteo/jurado) se sirve en /jurado/. */
  private servirPwa(context: ModuleContext): void {
    const raiz = context.config.string(
      'JURADO_DIR',
      fileURLToPath(new URL('../../../jurado/dist', import.meta.url)),
    );
    if (!existsSync(raiz)) {
      context.http.log.warn(`No se encontró la PWA del jurado en ${raiz}; ejecute "npm run build -w @preconteo/jurado"`);
      return;
    }
    registerStaticFiles(context.http, raiz, '/jurado/');
  }

  async start(): Promise<void> {
    await this.redis?.conectar();
  }

  async stop(): Promise<void> {
    await this.jurados?.cerrar();
    await this.redis?.cerrar();
  }
}
