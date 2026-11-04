/** Lectura mínima de argumentos "--nombre=valor" / "--bandera". */
export class CliArgs {
  private readonly values = new Map<string, string>();

  constructor(argv: string[] = process.argv.slice(2)) {
    for (const arg of argv) {
      const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
      if (match) this.values.set(match[1]!, match[2] ?? 'true');
    }
  }

  string(name: string, fallback: string): string {
    return this.values.get(name) ?? fallback;
  }

  number(name: string, fallback: number): number {
    const value = Number(this.values.get(name));
    return Number.isFinite(value) ? value : fallback;
  }

  flag(name: string): boolean {
    return this.values.get(name) === 'true';
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}
