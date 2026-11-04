/**
 * Jornada simulada activable desde la consola (RT-10).
 *
 * Ejecuta el plan de `@votaciones/shared` (perfil del documento de diseño) con
 * la ingesta REAL de esta instancia: las actas pasan por aplicar_acta.lua,
 * llegan al público por los streams y las dudosas a la cola de auditores.
 *
 * Distribuida sin hablar con otras réplicas (RT-3): un candado en Redis
 * (`jornada:candado`, renovado cada 2 s) garantiza que solo una la ejecute, y el
 * estado vive en `jornada:estado` para que cualquier réplica lo informe. Si la
 * réplica que la ejecuta muere, el candado vence y el estado queda
 * "interrumpida"; se puede volver a iniciar desde cualquier réplica.
 */
import {
  GEOGRAFIA_DEFECTO,
  claves,
  juradoDeMesa,
  planJornada,
  resumenPlan,
  topico,
  ubicacionDeMesa,
  type Geografia,
} from '@votaciones/shared';
import type { ConexionRedis } from '../redis/conexion.js';
import type { ServicioIngesta } from './servicio.js';

export interface OpcionesInicio {
  /** 1 = tiempo real (2 h); 60 = la jornada en 2 min. */
  aceleracion: number;
  /** Borra resultados, actas y casos antes de empezar (conserva catálogo y presencia). */
  reiniciar: boolean;
  actas?: number;
  /** Duración simulada (min); por defecto 120. */
  duracionMin?: number;
  semilla?: number;
}

export type EstadoJornada =
  | { estado: 'inactiva' }
  | {
      estado: 'en_curso' | 'terminada' | 'detenida' | 'interrumpida';
      instancia: string;
      inicio: number;
      aceleracion: number;
      solicitudes: number;
      enviadas: number;
      porEstado: Record<string, number>;
      fin?: number;
    };

const CANDADO_MS = 10_000;
const CONCURRENCIA = 50;

/** Renueva el candado solo si sigue siendo nuestro (no pisa a otra réplica). */
const RENOVAR = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
const LIBERAR = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** Claves de resultados que borra "reiniciar". Nunca cat:*, jur:* ni pres:*. */
const PATRONES_REINICIO = [
  'tot:*',
  'rank:*',
  'st:*',
  'acta:*',
  'idem:*',
  'resolucion:*',
  'verif:*',
  'rl:*',
  'lock:caso:*',
  'fence:caso:*',
  'seq:recibo',
];

export class JornadaSimulada {
  private corriendo = false;

  constructor(
    private readonly op: {
      redis: () => ConexionRedis | null;
      ingesta: () => ServicioIngesta | null;
      instancia: string;
      geografia?: Geografia;
      /**
       * La jornada escribe en los acumulados reales y entra a la ingesta sin
       * credencial de jurado: solo existe si se habilita a propósito
       * (SIMULACION_HABILITADA=true), nunca con datos de una elección real.
       */
      habilitada: boolean;
    },
  ) {}

  get habilitada(): boolean {
    return this.op.habilitada;
  }

  private get geografia(): Geografia {
    return this.op.geografia ?? GEOGRAFIA_DEFECTO;
  }

  private conexion(): ConexionRedis {
    const r = this.op.redis();
    if (!r) throw new Error('Ingesta no inicializada');
    return r;
  }

  async estado(): Promise<EstadoJornada> {
    const r = this.conexion();
    const plano = await r.comando<string[]>(['HGETALL', claves.jornadaEstado()]);
    if (plano.length === 0) return { estado: 'inactiva' };
    const h: Record<string, string> = {};
    for (let i = 0; i < plano.length; i += 2) h[plano[i]!] = plano[i + 1]!;
    let estado = h.estado as Exclude<EstadoJornada['estado'], 'inactiva'>;
    if (
      estado === 'en_curso' &&
      (await r.comando<number>(['EXISTS', claves.jornadaCandado()])) === 0
    ) {
      estado = 'interrumpida';
    }
    return {
      estado,
      instancia: h.instancia ?? '',
      inicio: Number(h.inicio),
      aceleracion: Number(h.aceleracion),
      solicitudes: Number(h.solicitudes),
      enviadas: Number(h.enviadas ?? 0),
      porEstado: h.porEstado ? (JSON.parse(h.porEstado) as Record<string, number>) : {},
      ...(h.fin ? { fin: Number(h.fin) } : {}),
    };
  }

  /** Pide detener la jornada (la réplica que la ejecuta lo ve en su siguiente ciclo). */
  async detener(): Promise<boolean> {
    const r = this.conexion();
    if ((await r.comando<number>(['EXISTS', claves.jornadaCandado()])) === 0) return false;
    await r.comando(['HSET', claves.jornadaEstado(), 'detener', '1']);
    return true;
  }

  /** Toma el candado y arranca en segundo plano. Devuelve false si ya hay una en curso. */
  async iniciar(
    opciones: OpcionesInicio,
  ): Promise<
    { ok: true; resumen: ReturnType<typeof resumenPlan> } | { ok: false; motivo: string }
  > {
    if (!this.op.habilitada) return { ok: false, motivo: 'DESHABILITADA' };
    const r = this.conexion();
    const ingesta = this.op.ingesta();
    if (!ingesta) return { ok: false, motivo: 'INGESTA_NO_LISTA' };
    const aceleracion = Math.min(600, Math.max(1, Math.round(opciones.aceleracion)));
    const tomado = await r.comando<string | null>([
      'SET',
      claves.jornadaCandado(),
      this.op.instancia,
      'NX',
      'PX',
      String(CANDADO_MS),
    ]);
    if (tomado !== 'OK') return { ok: false, motivo: 'EN_CURSO' };

    try {
      if (opciones.reiniciar) await this.reiniciarDatos();
      await this.cargarCatalogo();
      const plan = planJornada({
        geografia: this.geografia,
        ...(opciones.actas ? { actas: opciones.actas } : {}),
        ...(opciones.duracionMin ? { duracionMin: opciones.duracionMin } : {}),
        // Semilla fija: repetir la jornada sin borrar reenvía los mismos idem y todo vuelve
        // YA_REGISTRADA (demuestra la idempotencia en vez de generar conflictos).
        ...(opciones.semilla !== undefined ? { semilla: opciones.semilla } : {}),
      });
      await r.comando(['DEL', claves.jornadaEstado()]);
      await r.comando([
        'HSET',
        claves.jornadaEstado(),
        'estado',
        'en_curso',
        'instancia',
        this.op.instancia,
        'inicio',
        String(Date.now()),
        'aceleracion',
        String(aceleracion),
        'solicitudes',
        String(plan.length),
        'enviadas',
        '0',
        'porEstado',
        '{}',
      ]);
      this.corriendo = true;
      void this.ejecutar(plan, aceleracion, ingesta).finally(() => {
        this.corriendo = false;
      });
      return { ok: true, resumen: resumenPlan(plan) };
    } catch (e) {
      await r
        .comando(['EVAL', LIBERAR, '1', claves.jornadaCandado(), this.op.instancia])
        .catch(() => {});
      throw e;
    }
  }

  get activa(): boolean {
    return this.corriendo;
  }

  private async ejecutar(
    plan: ReturnType<typeof planJornada>,
    aceleracion: number,
    ingesta: ServicioIngesta,
  ): Promise<void> {
    const r = this.conexion();
    const t0 = Date.now();
    const porEstado: Record<string, number> = {};
    let enviadas = 0;
    let siguienteRevision = 0;
    let final: 'terminada' | 'detenida' | 'interrumpida' = 'terminada';
    const enVuelo = new Set<Promise<void>>();

    /** Cada 2 s: renovar el candado, mirar si pidieron detener y publicar el avance. */
    const revisar = async (): Promise<typeof final | null> => {
      if (Date.now() < siguienteRevision) return null;
      siguienteRevision = Date.now() + 2000;
      const renovado = await r
        .comando<number>([
          'EVAL',
          RENOVAR,
          '1',
          claves.jornadaCandado(),
          this.op.instancia,
          String(CANDADO_MS),
        ])
        .catch(() => 0);
      if (!renovado) return 'interrumpida';
      const pedido = await r
        .comando<string | null>(['HGET', claves.jornadaEstado(), 'detener'])
        .catch(() => null);
      if (pedido === '1') return 'detenida';
      await r
        .comando([
          'HSET',
          claves.jornadaEstado(),
          'enviadas',
          String(enviadas),
          'porEstado',
          JSON.stringify(porEstado),
        ])
        .catch(() => {});
      return null;
    };

    recorrido: for (const envio of plan) {
      const objetivo = t0 + envio.enMs / aceleracion;
      do {
        const corte = await revisar();
        if (corte) {
          final = corte;
          break recorrido;
        }
        const espera = objetivo - Date.now();
        if (espera > 0) await new Promise((ok) => setTimeout(ok, Math.min(espera, 1000)));
      } while (Date.now() < objetivo);
      while (enVuelo.size >= CONCURRENCIA) await Promise.race(enVuelo);
      const tarea: Promise<void> = ingesta
        .recibir(envio.acta, null)
        .then((res) => {
          porEstado[res.estado] = (porEstado[res.estado] ?? 0) + 1;
        })
        .catch(() => {
          porEstado.ERROR = (porEstado.ERROR ?? 0) + 1;
        })
        .finally(() => {
          enviadas++;
          enVuelo.delete(tarea);
        });
      enVuelo.add(tarea);
    }
    await Promise.all(enVuelo);
    await r
      .comando([
        'HSET',
        claves.jornadaEstado(),
        'estado',
        final,
        'enviadas',
        String(enviadas),
        'porEstado',
        JSON.stringify(porEstado),
        'fin',
        String(Date.now()),
      ])
      .catch(() => {});
    await r
      .comando(['EVAL', LIBERAR, '1', claves.jornadaCandado(), this.op.instancia])
      .catch(() => {});
  }

  private async reiniciarDatos(): Promise<void> {
    const r = this.conexion();
    for (const patron of PATRONES_REINICIO) {
      let cursor = '0';
      do {
        const [siguiente, encontradas] = await r.comando<[string, string[]]>([
          'SCAN',
          cursor,
          'MATCH',
          patron,
          'COUNT',
          '1000',
        ]);
        cursor = siguiente;
        if (encontradas.length) await r.comando(['UNLINK', ...encontradas]);
      } while (cursor !== '0');
    }
  }

  /** Catálogo y asignación jurado → mesa, si faltan (idempotente). */
  private async cargarCatalogo(): Promise<void> {
    const r = this.conexion();
    const g = this.geografia;
    const ultimo = await r.comando<string | null>(['HGET', claves.catMesa(g.mesas), 'puesto']);
    const totalCargado = await r.comando<string | null>([
      'HGET',
      claves.tot(topico.dep()),
      'mesas_tot',
    ]);
    if (ultimo && totalCargado) return;
    const porTopico = new Map<string, number>();
    const lote = 500;
    for (let desde = 1; desde <= g.mesas; desde += lote) {
      const multi = r.cliente.multi();
      for (let mesa = desde; mesa < Math.min(desde + lote, g.mesas + 1); mesa++) {
        const u = ubicacionDeMesa(mesa, g);
        multi.hSet(claves.catMesa(mesa), {
          puesto: String(u.puesto),
          municipio: String(u.municipio),
        });
        multi.sAdd(claves.mesasJurado(juradoDeMesa(mesa)), String(mesa));
        for (const t of [topico.pue(u.puesto), topico.mun(u.municipio), topico.dep()]) {
          porTopico.set(t, (porTopico.get(t) ?? 0) + 1);
        }
      }
      await multi.exec();
    }
    const multi = r.cliente.multi();
    for (const [t, n] of porTopico)
      multi.hSet(claves.tot(t as Parameters<typeof claves.tot>[0]), 'mesas_tot', String(n));
    await multi.exec();
  }
}
