/**
 * Tópico de resultados al que se suscribe un cliente público.
 * Formato textual: "dep" | "mun:<id>" | "pue:<id>".
 * Objeto de valor inmutable: dos tópicos con el mismo texto son iguales.
 */
export type TopicLevel = 'dep' | 'mun' | 'pue';

const TOPIC_PATTERN = /^(dep)$|^(mun|pue):(\d{1,6})$/;

export class Topic {
  /** Tópico departamental: único y suscrito por casi todos. */
  static readonly DEPARTMENT = new Topic('dep', null);

  private constructor(
    readonly level: TopicLevel,
    readonly entityId: number | null,
  ) {}

  static municipality(id: number): Topic {
    return new Topic('mun', Topic.assertId(id));
  }

  static pollingStation(id: number): Topic {
    return new Topic('pue', Topic.assertId(id));
  }

  /** Interpreta "dep", "mun:11" o "pue:176"; devuelve null si el texto no es válido. */
  static tryParse(raw: string): Topic | null {
    const match = TOPIC_PATTERN.exec(raw.trim());
    if (!match) return null;
    if (match[1] === 'dep') return Topic.DEPARTMENT;
    const id = Number(match[3]);
    return match[2] === 'mun' ? Topic.municipality(id) : Topic.pollingStation(id);
  }

  static parse(raw: string): Topic {
    const topic = Topic.tryParse(raw);
    if (!topic) throw new Error(`Tópico inválido: "${raw}"`);
    return topic;
  }

  private static assertId(id: number): number {
    if (!Number.isInteger(id) || id < 0) throw new Error(`Identificador de tópico inválido: ${id}`);
    return id;
  }

  /** Clave canónica usada en mapas, mensajes y cursores. */
  toString(): string {
    return this.level === 'dep' ? 'dep' : `${this.level}:${this.entityId}`;
  }

  equals(other: Topic): boolean {
    return this.toString() === other.toString();
  }
}
