/**
 * Conexión de comandos a Redis con las garantías de RF-10:
 *
 * - `disableOfflineQueue`: si el socket está caído, el comando falla al
 *   instante en vez de quedarse esperando en memoria. Un acta nunca queda
 *   "en el aire" dentro del servidor.
 * - Timeout por comando (300 ms por defecto).
 * - Circuit breaker: tras varios fallos seguidos se responde NO_REGISTRADA sin
 *   esperar, hasta que una prueba vuelva a salir bien.
 *
 * Ojo: un timeout NO significa que el comando no se ejecutó. Si el script ya
 * corrió y la respuesta se perdió, el jurado recibe NO_REGISTRADA, reintenta
 * con el mismo `idem` y obtiene YA_REGISTRADA con el recibo original. Nunca
 * hay un recibo sin registro; puede haber un registro con el recibo demorado.
 */
import { readFileSync } from 'node:fs';
import { createClient, ErrorReply, type RedisClientType } from 'redis';
import { Circuito, TiempoAgotado } from './circuito.js';

/** Cliente RESP2 sin módulos extra. */
export type ClienteRedis = RedisClientType<{}, {}, {}, 2>;

export type RespuestaRedis = string | number | null | RespuestaRedis[];

export interface OpcionesRedis {
  url: string;
  timeoutMs: number;
  /** Nombre de la conexión en CLIENT LIST (ayuda a C con las métricas). */
  nombre?: string;
}

export const NOMBRES_SCRIPTS = ['aplicar_acta', 'leer_topico', 'limite_tasa'] as const;
export type NombreScript = (typeof NOMBRES_SCRIPTS)[number];

const leerLua = (nombre: NombreScript): string =>
  readFileSync(new URL(`./lua/${nombre}.lua`, import.meta.url), 'utf8');

/** Errores en los que Redis sí respondió: no indican que esté caído. */
const esRespuestaDeRedis = (e: unknown): boolean => e instanceof ErrorReply;

export class ConexionRedis {
  readonly cliente: ClienteRedis;
  readonly circuito: Circuito;
  private readonly fuentes = new Map<NombreScript, string>();
  private readonly shas = new Map<NombreScript, string>();

  constructor(private readonly op: OpcionesRedis) {
    this.cliente = createClient({
      url: op.url,
      name: op.nombre ?? 'preconteo',
      // RESP2: las respuestas crudas son arreglos planos (HGETALL, XRANGE),
      // igual que dentro de los scripts Lua y que en redis-cli.
      RESP: 2,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2000,
        // Reintento con tope: el servidor sigue vivo (/live) mientras tanto.
        reconnectStrategy: (intento) => Math.min(100 * 2 ** intento, 2000),
      },
    });
    // Sin este listener, un error de socket tumba el proceso.
    this.cliente.on('error', () => {});
    this.circuito = new Circuito({ esFallo: (e) => !esRespuestaDeRedis(e) });
    for (const n of NOMBRES_SCRIPTS) this.fuentes.set(n, leerLua(n));
  }

  /**
   * Conecta sin bloquear el arranque: si Redis no está, la instancia arranca
   * igual (/live = 200, /ready = 503) y node-redis sigue reintentando.
   */
  async conectar(esperarMs = 3000): Promise<void> {
    this.cliente.on('ready', () => {
      this.cargarScripts().catch(() => {});
    });
    const conexion = this.cliente.connect().then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([conexion, new Promise((r) => setTimeout(r, esperarMs).unref())]);
  }

  async cerrar(): Promise<void> {
    if (this.cliente.isOpen) await this.cliente.close();
  }

  get lista(): boolean {
    return this.cliente.isReady && this.circuito.estado !== 'ABIERTO';
  }

  private async cargarScripts(): Promise<void> {
    for (const [nombre, fuente] of this.fuentes) {
      const sha = (await this.cliente.sendCommand(['SCRIPT', 'LOAD', fuente])) as string;
      this.shas.set(nombre, sha);
    }
  }

  /** Cualquier comando, con timeout y circuit breaker. */
  comando<T = RespuestaRedis>(args: string[]): Promise<T> {
    return this.circuito.ejecutar(() => this.conTimeout<T>(args));
  }

  /**
   * EVALSHA con el script ya cargado. Si Redis se reinició y olvidó el
   * script (NOSCRIPT), lo vuelve a cargar y reintenta una vez.
   */
  script<T = RespuestaRedis>(nombre: NombreScript, keys: string[], args: string[]): Promise<T> {
    return this.circuito.ejecutar(async () => {
      const evalsha = (sha: string) =>
        this.conTimeout<T>(['EVALSHA', sha, String(keys.length), ...keys, ...args]);
      const sha = this.shas.get(nombre);
      try {
        if (!sha) throw new ErrorReply('NOSCRIPT sin cargar');
        return await evalsha(sha);
      } catch (e) {
        if (!(e instanceof ErrorReply) || !e.message.startsWith('NOSCRIPT')) throw e;
        const nuevo = (await this.conTimeout<string>(['SCRIPT', 'LOAD', this.fuentes.get(nombre)!]));
        this.shas.set(nombre, nuevo);
        return await evalsha(nuevo);
      }
    });
  }

  private async conTimeout<T>(args: string[]): Promise<T> {
    let temporizador: NodeJS.Timeout | undefined;
    const limite = new Promise<never>((_, rechazar) => {
      temporizador = setTimeout(() => rechazar(new TiempoAgotado(this.op.timeoutMs)), this.op.timeoutMs);
    });
    try {
      return (await Promise.race([this.cliente.sendCommand(args), limite])) as T;
    } finally {
      clearTimeout(temporizador);
    }
  }
}
