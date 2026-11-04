import { describe, expect, it } from 'vitest';
import { credencialDeCabecera, emitirCredencial, verificarCredencial } from './credencial.js';

const SECRETO = 'secreto-de-pruebas-con-32-caracteres!';
const AHORA = 1_793_577_600;

describe('credencial del jurado', () => {
  it('una credencial emitida se verifica y entrega el jurado', () => {
    const c = emitirCredencial(SECRETO, 'JUR-4201', AHORA + 3600);
    expect(c).toMatch(/^v1\.JUR-4201\.\d+\.[A-Za-z0-9_-]+$/);
    expect(verificarCredencial(SECRETO, c, AHORA)).toEqual({
      ok: true,
      credencial: { jurado: 'JUR-4201', vence: AHORA + 3600 },
    });
  });

  it('rechaza firma alterada, otro secreto, jurado cambiado y vencimiento', () => {
    const c = emitirCredencial(SECRETO, 'JUR-4201', AHORA + 3600);
    const firma = c.split('.')[3]!;
    const alterada = c.slice(0, -firma.length) + (firma[0] === 'A' ? 'B' : 'A') + firma.slice(1);
    expect(verificarCredencial(SECRETO, alterada, AHORA)).toMatchObject({ ok: false, motivo: 'FIRMA_INVALIDA' });
    expect(verificarCredencial(`${SECRETO}-otro`, c, AHORA)).toMatchObject({ ok: false, motivo: 'FIRMA_INVALIDA' });
    expect(verificarCredencial(SECRETO, c.replace('JUR-4201', 'JUR-4202'), AHORA)).toMatchObject({
      ok: false,
      motivo: 'FIRMA_INVALIDA',
    });
    expect(verificarCredencial(SECRETO, c, AHORA + 3600)).toMatchObject({ ok: false, motivo: 'VENCIDA' });
  });

  it('distingue credencial ausente y mal formada', () => {
    expect(verificarCredencial(SECRETO, undefined, AHORA)).toMatchObject({ ok: false, motivo: 'AUSENTE' });
    for (const mala of ['abc', 'v2.JUR-1.9999999999.x', 'v1.JUAN.9999999999.x', 'v1.JUR-1.-5.x']) {
      expect(verificarCredencial(SECRETO, mala, AHORA)).toMatchObject({ ok: false, motivo: 'MAL_FORMADA' });
    }
  });

  it('extrae la credencial de la cabecera Bearer', () => {
    expect(credencialDeCabecera('Bearer v1.a')).toBe('v1.a');
    expect(credencialDeCabecera('Basic x')).toBeUndefined();
    expect(credencialDeCabecera(undefined)).toBeUndefined();
  });
});
