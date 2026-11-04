import { test, expect } from '@playwright/test';
import { createClient } from 'redis';

const votos = { C1:'184', C2:'97', C3:'311', BLANCO:'22', NULO:'9', NO_MARCADO:'4' };
async function llenar(page: import('@playwright/test').Page): Promise<void> {
  for (const [casilla, valor] of Object.entries(votos)) await page.locator(`[data-voto="${casilla}"]`).fill(valor);
}
let redis: ReturnType<typeof createClient>;
test.beforeAll(async()=>{
  redis=createClient({url:process.env.REDIS_URL_E2E ?? 'redis://localhost:6379/13'});await redis.connect();
});
test.afterAll(async()=>{await redis.quit();});
test.beforeEach(async()=>{
  await redis.flushDb();
  await redis.hSet('cat:mesa:4201',{puesto:176,municipio:11});
});

test('transmite un acta y muestra su recibo en pantalla móvil',async({page})=>{
  const errores:string[]=[];page.on('pageerror',e=>errores.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Nueva transmisión'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await llenar(page);
  await expect(page.locator('#total')).toHaveText('Total: 627');
  await page.screenshot({path:'test-results/jurado-movil.png',fullPage:true});
  await page.getByRole('button',{name:'Guardar y transmitir'}).click();
  await expect(page.locator('#aviso')).toContainText(/REGISTRADA|YA_REGISTRADA/,{timeout:10000});
  await expect(page.locator('#aviso')).toContainText(/R-\d{6}/);
  await expect(page.locator('#resumen')).toHaveText('Sin envíos pendientes.');
  expect(errores).toEqual([]);
});

test('guarda sin red y reintenta automáticamente al recuperar conexión',async({page,context})=>{
  await page.goto('/');
  await llenar(page);
  await context.setOffline(true);
  await page.getByRole('button',{name:'Guardar y transmitir'}).click();
  await expect(page.locator('#resumen')).toHaveText('1 envío pendiente');
  const guardado=await page.evaluate(async()=>new Promise<number>((resolve,reject)=>{const r=indexedDB.open('preconteo-jurado');r.onsuccess=()=>{const q=r.result.transaction('salida').objectStore('salida').count();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);};r.onerror=()=>reject(r.error);}));
  expect(guardado).toBe(1);
  await context.setOffline(false);
  await expect(page.locator('#resumen')).toHaveText('Sin envíos pendientes.',{timeout:15000});
  await expect(page.locator('#aviso')).toContainText(/REGISTRADA|YA_REGISTRADA/);
});

test('recarga sin red conserva la aplicación y el envío pendiente',async({page,context})=>{
  await page.goto('/');
  await expect.poll(()=>page.evaluate(async()=>{
    const cache=await caches.open('actas-v3');
    const recursos=performance.getEntriesByType('resource').map(r=>r.name).filter(url=>new URL(url).origin===location.origin);
    return recursos.length>0&&(await Promise.all(recursos.map(url=>cache.match(url)))).every(Boolean);
  })).toBe(true);
  await llenar(page);
  await context.setOffline(true);
  await page.getByRole('button',{name:'Guardar y transmitir'}).click();
  await expect(page.locator('#resumen')).toHaveText('1 envío pendiente');
  await page.reload();
  await expect(page.getByRole('heading',{name:'Nueva transmisión'})).toBeVisible();
  await expect(page.locator('#resumen')).toHaveText('1 envío pendiente');
  await context.setOffline(false);
  await expect(page.locator('#resumen')).toHaveText('Sin envíos pendientes.',{timeout:15000});
  await expect(page.locator('#aviso')).toContainText(/REGISTRADA|YA_REGISTRADA/);
});

test('la instancia sirve la PWA en /jurado/ y el enlace con credencial (fragmento) no queda en la URL',async({page})=>{
  const errores:string[]=[];page.on('pageerror',e=>errores.push(e.message));
  // Sin JURADO_SECRETO el servidor no verifica la firma; aquí se prueba el flujo del enlace.
  const credencial='v1.JUR-88134.9999999999.abcdefghijklmnopqrstuvwxyz012345';
  await page.goto(`http://127.0.0.1:3000/jurado#credencial=${credencial}`);
  await expect(page).toHaveURL('http://127.0.0.1:3000/jurado/');
  await expect(page.locator('#jurado')).toHaveValue('JUR-88134');
  await expect(page.locator('#jurado')).toHaveJSProperty('readOnly',true);
  await llenar(page);
  await page.getByRole('button',{name:'Guardar y transmitir'}).click();
  await expect(page.locator('#aviso')).toContainText(/REGISTRADA/,{timeout:10000});
  await expect(page.locator('#red')).toHaveText('Canal listo');
  expect(errores).toEqual([]);
});
