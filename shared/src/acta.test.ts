import { describe, expect, it } from 'vitest';
import { cuadraContable, firmaContenido, validarActa } from './acta.js';

const base = () => ({
  acta: 'E14-176-0042-03',
  mesa: 4201,
  puesto: 176,
  municipio: 11,
  version: 1,
  jurado: 'JUR-88134',
  ts_cierre: 1793577600,
  votos: { C1: 184, C2: 97, C3: 311, BLANCO: 22, NULO: 9, NO_MARCADO: 4 },
  sufragantes: 627,
  hash_foto: '9f2c',
  idem: '8f14e45fceea167a',
});

describe('validarActa', () => {
  it('acepta el ejemplo del enunciado', () => {
    const r = validarActa(base());
    expect(r.ok).toBe(true);
  });

  it('descarta campos extra y ordena las casillas', () => {
    const r = validarActa({ ...base(), extra: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.acta)).not.toContain('extra');
      expect(Object.keys(r.acta.votos)).toEqual(['C1', 'C2', 'C3', 'BLANCO', 'NULO', 'NO_MARCADO']);
    }
  });

  it.each([
    ['no es objeto', 'hola'],
    ['acta mal formada', { ...base(), acta: 'X-1' }],
    ['version 0', { ...base(), version: 0 }],
    ['votos negativos', { ...base(), votos: { ...base().votos, C1: -1 } }],
    ['votos decimales', { ...base(), votos: { ...base().votos, C2: 1.5 } }],
    ['falta casilla', { ...base(), votos: { C1: 1, C2: 2, C3: 3, BLANCO: 0, NULO: 0 } }],
    ['casilla desconocida', { ...base(), votos: { ...base().votos, C9: 1 } }],
    ['idem corto', { ...base(), idem: 'abc' }],
    ['puesto no coincide con el id', { ...base(), puesto: 177 }],
  ])('rechaza: %s', (_n, entrada) => {
    expect(validarActa(entrada).ok).toBe(false);
  });
});

describe('cuadraContable', () => {
  it('cuadra cuando la suma de casillas es igual a sufragantes', () => {
    expect(cuadraContable(base())).toBe(true);
  });
  it('no cuadra si falta o sobra un voto', () => {
    expect(cuadraContable({ ...base(), sufragantes: 626 })).toBe(false);
    expect(cuadraContable({ ...base(), sufragantes: 628 })).toBe(false);
  });
});

describe('firmaContenido', () => {
  it('cambia si cambia un voto', () => {
    const a = base();
    const b = { ...base(), votos: { ...base().votos, C1: 183, BLANCO: 23 } };
    expect(firmaContenido(a)).not.toBe(firmaContenido(b));
  });
});
