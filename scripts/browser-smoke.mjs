import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = 'docs/evidence';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'chrome',
  headless: true,
});
const ana = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const luis = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const coord = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const errors = [];
for (const ctx of [ana, luis, coord])
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
const a = await ana.newPage(),
  b = await luis.newPage(),
  c = await coord.newPage();
const result = { browser: 'Chrome headless', replicas: ['c-local-1', 'c-local-2'], checks: [] };
try {
  await a.goto('http://127.0.0.1:8081');
  await a.getByRole('button', { name: 'Ana · auditora' }).click();
  await a.getByText('Ana Torres', { exact: true }).waitFor();
  await a.getByRole('button').filter({ hasText: 'E14-176-0042-03' }).click();
  await a.getByRole('button', { name: 'Tomar este caso' }).click();
  await a.getByText('Estás revisando este caso', { exact: true }).waitFor();
  result.checks.push('Ana toma un caso desde la réplica 1');

  await b.goto('http://127.0.0.1:8082');
  await b.getByRole('button', { name: 'Luis · auditor' }).click();
  await b.getByText('Luis Rojas', { exact: true }).waitFor();
  await b.getByRole('button').filter({ hasText: 'E14-176-0042-03' }).click();
  await b.locator('.assignment').getByText('Ana Torres', { exact: true }).waitFor();
  assert.equal(await b.getByRole('button', { name: 'Tomar este caso' }).count(), 0);
  result.checks.push('Luis ve la asignación desde la réplica 2 y no puede tomarla');

  await a.getByLabel('Observación de la revisión').fill('Se verificó contra el acta física.');
  await a.getByRole('button', { name: 'Solicitar resolución' }).click();
  await a.getByRole('status').filter({ hasText: 'Resolución sin aplicar' }).waitFor();
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.screenshot({ path: `${output}/consola-verificacion.png`, fullPage: true });
  result.checks.push('La resolución pendiente no se presenta como aplicada');

  await c.goto('http://127.0.0.1:8080');
  await c.getByRole('button', { name: 'Coordinación', exact: true }).click();
  await c.getByRole('button', { name: 'Plataforma', exact: false }).click();
  await c.getByRole('cell', { name: 'c-local-1', exact: true }).waitFor();
  await c.getByRole('cell', { name: 'c-local-2', exact: true }).waitFor();
  await c.waitForFunction(
    () => Number(document.querySelectorAll('.stat strong')[1]?.textContent) >= 3,
  );
  await c.screenshot({ path: `${output}/plataforma.png`, fullPage: true });
  result.checks.push('El tablero muestra métricas de las dos réplicas y pendientes de A/B');
  await a.setViewportSize({ width: 390, height: 844 });
  assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await a.screenshot({ path: `${output}/consola-movil.png`, fullPage: true });
  result.checks.push('Sin desbordamiento horizontal a 390 px');
  await a.setViewportSize({ width: 1440, height: 1050 });
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.clock.install();
  await a.clock.fastForward(480001);
  await a.getByRole('alert').filter({ hasText: 'Llevas 8 minutos' }).waitFor();
  await a.getByRole('button', { name: 'Sigo trabajando' }).click();
  assert.equal(await a.getByRole('alert').count(), 0);
  result.checks.push('Aviso de 8 minutos comprobado con reloj de navegador adelantado');
  await a.getByRole('button', { name: 'Liberar y devolver a la cola' }).click();
  await a.getByRole('status').filter({ hasText: 'volvió a la cola' }).waitFor();
  assert.deepEqual(errors, []);
  result.checks.push('Sin errores JavaScript de la aplicación');
  result.date = new Date().toISOString();
  writeFileSync(`${output}/browser.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
