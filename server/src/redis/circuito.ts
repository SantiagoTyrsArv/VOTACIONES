/**
 * Circuit breaker para Redis (RF-10).
 *
 * CERRADO: todo pasa. Tras `fallosParaAbrir` fallos seguidos → ABIERTO.
 * ABIERTO: se rechaza al instante durante `msAbierto`, sin esperar timeouts,
 *          para que el jurado reciba NO_REGISTRADA rápido y su cola reintente.
 * SEMIABIERTO: pasa UNA prueba; si sale bien → CERRADO, si falla → ABIERTO.
 */
export type EstadoCircuito = 'CERRADO' | 'ABIERTO' | 'SEMIABIERTO';

export class CircuitoAbierto extends Error {
  constructor(readonly reintentarEnMs: number) {
    super('Redis no disponible (circuito abierto)');
  }
}

export class TiempoAgotado extends Error {
  constructor(ms: number) {
    super(`Redis no respondió en ${ms} ms`);
  }
}

export interface OpcionesCircuito {
  fallosParaAbrir?: number;
  msAbierto?: number;
  ahora?: () => number;
  /** Qué errores cuentan como "Redis no disponible". Por defecto, todos. */
  esFallo?: (e: unknown) => boolean;
}

export class Circuito {
  private estadoInterno: EstadoCircuito = 'CERRADO';
  private fallos = 0;
  private abiertoDesde = 0;
  private pruebaEnCurso = false;
  private readonly fallosParaAbrir: number;
  private readonly msAbierto: number;
  private readonly ahora: () => number;
  private readonly esFallo: (e: unknown) => boolean;

  constructor(op: OpcionesCircuito = {}) {
    this.fallosParaAbrir = op.fallosParaAbrir ?? 3;
    this.msAbierto = op.msAbierto ?? 2000;
    this.ahora = op.ahora ?? Date.now;
    this.esFallo = op.esFallo ?? (() => true);
  }

  get estado(): EstadoCircuito {
    if (this.estadoInterno === 'ABIERTO' && this.ahora() - this.abiertoDesde >= this.msAbierto) {
      this.estadoInterno = 'SEMIABIERTO';
    }
    return this.estadoInterno;
  }

  async ejecutar<T>(fn: () => Promise<T>): Promise<T> {
    const estado = this.estado;
    if (estado === 'ABIERTO') {
      throw new CircuitoAbierto(this.msAbierto - (this.ahora() - this.abiertoDesde));
    }
    if (estado === 'SEMIABIERTO') {
      if (this.pruebaEnCurso) throw new CircuitoAbierto(this.msAbierto);
      this.pruebaEnCurso = true;
    }
    try {
      const r = await fn();
      this.fallos = 0;
      this.estadoInterno = 'CERRADO';
      return r;
    } catch (e) {
      if (!this.esFallo(e)) {
        // Redis respondió (p. ej. error de un script): está disponible.
        this.fallos = 0;
        this.estadoInterno = 'CERRADO';
        throw e;
      }
      this.fallos += 1;
      if (estado === 'SEMIABIERTO' || this.fallos >= this.fallosParaAbrir) {
        this.estadoInterno = 'ABIERTO';
        this.abiertoDesde = this.ahora();
      }
      throw e;
    } finally {
      if (estado === 'SEMIABIERTO') this.pruebaEnCurso = false;
    }
  }
}
