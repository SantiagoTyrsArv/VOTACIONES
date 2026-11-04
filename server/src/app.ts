/**
 * Construcción de una instancia. Las 8 réplicas corren exactamente esto; no
 * hay estado propio que importe: todo lo que debe sobrevivir vive en Redis.
 *
 * Cada módulo se registra aquí:
 *   - Ingesta (A): POST /actas, GET /actas/:id, WS /ws/jurados
 *   - Difusión (B): SSE y polling — se cuelga con `app.registrarWs` / rutas Fastify
 *   - Verificación (C): WS /ws/auditores, /whoami, métricas
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { WebSocketServer } from 'ws';
import type { Config } from './config.js';
import { registrarHttpIngesta } from './ingesta/http.js';
import { ServicioIngesta } from './ingesta/servicio.js';
import { crearWsJurados } from './ingesta/ws-jurados.js';
import { ConexionRedis } from './redis/conexion.js';

export interface App {
  http: FastifyInstance;
  redis: ConexionRedis;
  ingesta: ServicioIngesta;
  config: Config;
  /** Cuelga un WebSocketServer (`noServer: true`) en una ruta de upgrade. */
  registrarWs(ruta: string, wss: WebSocketServer): void;
  iniciar(): Promise<string>;
  cerrar(): Promise<void>;
}

export async function construirApp(config: Config, redis?: ConexionRedis): Promise<App> {
  const conexion =
    redis ?? new ConexionRedis({ url: config.redisUrl, timeoutMs: config.redisTimeoutMs, nombre: config.instancia });
  if (!redis) await conexion.conectar();

  const http = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const ingesta = new ServicioIngesta({
    redis: conexion,
    instancia: config.instancia,
    limiteActasPorMinuto: config.limiteActasPorMinuto,
  });

  // ── Salud (RF-10): /live dice "el proceso vive"; /ready dice "puedo
  // registrar actas". Si Redis cae, /ready = 503 pero /live sigue en 200
  // para que la plataforma no reinicie las 8 instancias en bucle.
  http.get('/live', async () => ({ ok: true, instancia: config.instancia }));
  http.get('/ready', async (_req, rep) => {
    const lista = conexion.lista;
    return rep
      .code(lista ? 200 : 503)
      .send({ ok: lista, instancia: config.instancia, redis: conexion.circuito.estado });
  });

  registrarHttpIngesta(http, { ingesta, redis: conexion, instancia: config.instancia });

  // ── Enrutador de upgrade: una sola escucha HTTP, varios WebSocketServer.
  const rutasWs = new Map<string, WebSocketServer>();
  const registrarWs = (ruta: string, wss: WebSocketServer) => {
    if (rutasWs.has(ruta)) throw new Error(`Ruta WebSocket duplicada: ${ruta}`);
    rutasWs.set(ruta, wss);
  };
  http.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const ruta = new URL(req.url ?? '/', 'http://x').pathname;
    const wss = rutasWs.get(ruta);
    if (!wss) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const jurados = crearWsJurados({ ingesta, instancia: config.instancia });
  registrarWs(jurados.ruta, jurados.wss);

  return {
    http,
    redis: conexion,
    ingesta,
    config,
    registrarWs,
    iniciar: () => http.listen({ port: config.puerto, host: config.host }),
    async cerrar() {
      await jurados.cerrar();
      await http.close();
      if (!redis) await conexion.cerrar();
    },
  };
}
