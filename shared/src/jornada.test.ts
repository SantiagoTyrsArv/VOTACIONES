import { describe, expect, it } from 'vitest';
import { validarActa } from './acta.js';
import { planJornada, resumenPlan, ubicacionDeMesa } from './jornada.js';

describe('jornada simulada', () => {
  const plan = planJornada();
  const r = resumenPlan(plan);

  it('sigue el perfil del documento de diseño', () => {
    expect(r.actas).toBe(6400);
    expect(r.fraccionPrimerTercio).toBeGreaterThan(0.54);
    expect(r.fraccionPrimerTercio).toBeLessThan(0.56);
    expect(r.reenvios / r.actas).toBeGreaterThan(0.04);
    expect(r.reenvios / r.actas).toBeLessThan(0.11);
    expect(r.dudosas / r.actas).toBeGreaterThan(0.05);
    expect(r.dudosas / r.actas).toBeLessThan(0.09);
    expect(r.correcciones).toBeGreaterThan(150);
    expect(r.correcciones).toBeLessThanOrEqual(180);
    // Pico normal ≈ 90/min; las ráfagas llegan a ~300/min.
    expect(r.maximoPorMinuto).toBeGreaterThanOrEqual(250);
  });

  it('es reproducible con la misma semilla y cambia con otra', () => {
    expect(planJornada({ semilla: 7, actas: 200 })).toEqual(
      planJornada({ semilla: 7, actas: 200 }),
    );
    expect(planJornada({ semilla: 8, actas: 200 })).not.toEqual(
      planJornada({ semilla: 7, actas: 200 }),
    );
  });

  it('cada envío es un acta válida, coherente con el catálogo, y los reenvíos repiten el idem', () => {
    for (const e of plan) {
      expect(validarActa(e.acta).ok).toBe(true);
      expect(ubicacionDeMesa(e.acta.mesa)).toMatchObject({
        puesto: e.acta.puesto,
        municipio: e.acta.municipio,
      });
    }
    const idems = new Set(plan.filter((e) => e.tipo === 'envio').map((e) => e.acta.idem));
    for (const e of plan.filter((x) => x.tipo === 'reenvio'))
      expect(idems.has(e.acta.idem)).toBe(true);
    for (const e of plan.filter((x) => x.tipo === 'correccion')) expect(e.acta.version).toBe(2);
  });

  it('está ordenado en el tiempo', () => {
    for (let i = 1; i < plan.length; i++)
      expect(plan[i]!.enMs).toBeGreaterThanOrEqual(plan[i - 1]!.enMs);
  });
});
