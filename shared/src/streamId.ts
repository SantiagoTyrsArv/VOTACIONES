/**
 * Identificador de entrada de Redis Streams: "<milisegundos>-<secuencia>".
 * Es monótono y común a todas las instancias, por eso sirve como cursor de continuidad.
 */
export class StreamId {
  static readonly ZERO = new StreamId(0n, 0n);

  private constructor(
    readonly millis: bigint,
    readonly sequence: bigint,
  ) {}

  static tryParse(raw: string | null | undefined): StreamId | null {
    if (!raw) return null;
    const match = /^(\d+)-(\d+)$/.exec(raw.trim());
    if (!match) return null;
    return new StreamId(BigInt(match[1]!), BigInt(match[2]!));
  }

  static parse(raw: string): StreamId {
    const id = StreamId.tryParse(raw);
    if (!id) throw new Error(`Id de stream inválido: "${raw}"`);
    return id;
  }

  /** Negativo si a < b, cero si son iguales, positivo si a > b. */
  static compare(a: StreamId, b: StreamId): number {
    if (a.millis !== b.millis) return a.millis < b.millis ? -1 : 1;
    if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
    return 0;
  }

  isAfter(other: StreamId): boolean {
    return StreamId.compare(this, other) > 0;
  }

  isAtOrBefore(other: StreamId): boolean {
    return StreamId.compare(this, other) <= 0;
  }

  /** Marca de tiempo aproximada (ms) en la que Redis creó la entrada. */
  get timestampMs(): number {
    return Number(this.millis);
  }

  toString(): string {
    return `${this.millis}-${this.sequence}`;
  }
}
