import { test, expect } from '@playwright/test';
import { createClient } from 'redis';

let redis: ReturnType<typeof createClient>;

test.beforeAll(async () => {
  redis = createClient({ url: 'redis://localhost:6379/13' });
  await redis.connect();
});

test.afterAll(async () => { await redis.quit(); });
test.beforeEach(async () => {
  await redis.flushDb();
  await redis.hSet('cat:mesa:4201', { puesto: 176, municipio: 11 });
  await redis.hSet('tot:dep', 'mesas_tot', 1);
});

test('un acta y su corrección llegan de la ingesta a la página pública por SSE', async ({ page, request }) => {
  await page.goto('http://127.0.0.1:5174/publico/');
  await expect(page.locator('[data-fase]')).toHaveText('En vivo');
  await expect(page.locator('[data-sufragantes]')).toHaveText('0');

  const acta = {
    acta: 'E14-176-4201-03', mesa: 4201, puesto: 176, municipio: 11, version: 1,
    jurado: 'JUR-88134', ts_cierre: Math.floor(Date.now() / 1000),
    votos: { C1: 184, C2: 97, C3: 311, BLANCO: 22, NULO: 9, NO_MARCADO: 4 },
    sufragantes: 627, hash_foto: 'integracion-e2e', idem: `integracion-${Date.now()}`,
  };
  const registrada = await request.post('http://127.0.0.1:3000/actas', { data: acta });
  expect(registrada.status()).toBe(201);
  await expect(page.locator('[data-sufragantes]')).toHaveText('627', { timeout: 10_000 });
  await expect(page.locator('[data-candidatos]')).toContainText('184');

  const corregida = await request.post('http://127.0.0.1:3000/actas', {
    data: {
      ...acta,
      version: 2,
      votos: { ...acta.votos, C1: 180, C2: 101 },
      idem: `integracion-correccion-${Date.now()}`,
    },
  });
  expect(corregida.status()).toBe(201);
  await expect(page.locator('[data-correcciones]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-correcciones-lista]')).toContainText('Corrección del acta');
  await expect(page.locator('[data-correcciones-lista]')).toContainText('v1 → v2');
  await expect(page.locator('[data-anomalias]')).toHaveText('0');
});
