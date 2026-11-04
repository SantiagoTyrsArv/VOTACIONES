import { CASILLAS, esEstadoFinal, validarActa, type Acta, type RespuestaIngesta } from '@votaciones/shared';
import { borrar, guardar, todos, type Pendiente } from './cola';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<main class="shell"><header><div class="marca"><img src="icono.svg" alt=""/><div><h1>Transmisión de actas</h1><p>Preconteo electoral · aplicación del jurado</p></div></div><span class="estado" id="red">Comprobando…</span></header><div class="layout"><section class="panel"><h2>Nueva transmisión</h2><p class="ayuda">El acta se conserva en este dispositivo hasta recibir una respuesta definitiva. Puedes cerrar o perder la red sin perder el envío.</p><form id="form"><div class="grid">
${[['acta','Identificador','E14-176-4201-03'],['mesa','Mesa','4201'],['puesto','Puesto','176'],['municipio','Municipio','11'],['version','Versión','1'],['jurado','Credencial','JUR-88134']].map(([n,l,v])=>`<div class="campo"><label for="${n}">${l}</label><input id="${n}" name="${n}" required value="${v}" ${n==='acta'||n==='jurado'?'':'type="number" min="1"'} /></div>`).join('')}
<div class="campo full"><label for="credencial">Credencial firmada</label><input id="credencial" name="credencial" autocomplete="off" spellcheck="false" placeholder="v1.JUR-…" /></div>
<div class="votos">${CASILLAS.map((c)=>`<div class="campo"><label for="v-${c}">${c.replaceAll('_',' ')}</label><input id="v-${c}" data-voto="${c}" required type="number" min="0" value="0" /></div>`).join('')}</div></div><div class="acciones"><button type="submit">Guardar y transmitir</button><span class="total" id="total">Total: 0</span></div><div id="aviso" role="status" aria-live="polite"></div></form></section><aside class="panel"><h2>Bandeja de salida</h2><p class="ayuda" id="resumen">Sin envíos pendientes.</p><button class="secundario" id="reintentar">Reintentar ahora</button><div class="lista" id="lista"></div><p class="pie">Una clave única acompaña cada envío y sus reintentos. Así, aunque cambies de red o de instancia, el acta cuenta una sola vez.</p></aside></div></main>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Credencial del jurado: llega por enlace (`?credencial=…`, p. ej. un QR) o se
 * escribe. Se quita de la URL para que no quede en el historial; se guarda con
 * cada acta en la cola (IndexedDB), así sobrevive a recargas sin red.
 */
const PATRON_CREDENCIAL = /^v1\.(JUR-\d{1,8})\.\d{1,12}\.[A-Za-z0-9_-]{20,}$/;
let credencial = '';
function usarCredencial(valor: string): void {
  const limpia = valor.trim();
  const m = PATRON_CREDENCIAL.exec(limpia);
  credencial = m ? limpia : '';
  $<HTMLInputElement>('credencial').value = limpia;
  $<HTMLInputElement>('credencial').setCustomValidity(limpia && !m ? 'Credencial con formato inválido' : '');
  const jurado = $<HTMLInputElement>('jurado');
  if (m) jurado.value = m[1]!;
  jurado.readOnly = Boolean(m);
  ws?.close();
}
{
  const url = new URL(location.href);
  const recibida = url.searchParams.get('credencial');
  if (recibida) {
    url.searchParams.delete('credencial');
    history.replaceState(null, '', url);
  }
  queueMicrotask(() => usarCredencial(recibida ?? ''));
}
const campos = ['acta','mesa','puesto','municipio','version','jurado'] as const;
let ws: WebSocket | undefined;
let procesando = false;
let temporizador: ReturnType<typeof setTimeout> | undefined;
const pendientesWs = new Map<string, (r: RespuestaIngesta) => void>();

function nuevoIdem(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
function conectar(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const protocolo = location.protocol === 'https:' ? 'wss' : 'ws';
  const consulta = credencial ? `?credencial=${encodeURIComponent(credencial)}` : '';
  ws = new WebSocket(`${protocolo}://${location.host}/ws/jurados${consulta}`);
  ws.onopen = () => { actualizarRed(); void procesar(); };
  ws.onclose = () => { actualizarRed(); setTimeout(conectar, 1000 + Math.random() * 3000); };
  ws.onerror = () => ws?.close();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.tipo === 'respuesta') pendientesWs.get(m.idem)?.(m.respuesta);
  };
}
function actualizarRed(): void {
  const activo = navigator.onLine && ws?.readyState === WebSocket.OPEN;
  $('red').textContent = activo ? 'Canal listo' : navigator.onLine ? 'Usando respaldo HTTP' : 'Sin conexión · cola activa';
  $('red').classList.toggle('online', activo);
}
async function enviar(acta: Acta, credencialActa = ''): Promise<RespuestaIngesta> {
  // El socket está autenticado con la credencial actual; otra credencial va por POST.
  if (ws?.readyState === WebSocket.OPEN && credencialActa === credencial) {
    const respuesta = new Promise<RespuestaIngesta>((resolve) => pendientesWs.set(acta.idem, resolve));
    ws.send(JSON.stringify({ tipo: 'acta', acta }));
    const tiempo = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado')), 3500));
    try { return await Promise.race([respuesta, tiempo]); }
    finally { pendientesWs.delete(acta.idem); }
  }
  const cabeceras: Record<string, string> = { 'content-type': 'application/json' };
  if (credencialActa) cabeceras.authorization = `Bearer ${credencialActa}`;
  const r = await fetch('/actas', { method:'POST', headers:cabeceras, body:JSON.stringify(acta) });
  return await r.json() as RespuestaIngesta;
}
async function renderLista(): Promise<void> {
  const ps = (await todos()).sort((a,b)=>a.proximo-b.proximo);
  $('resumen').textContent = ps.length ? `${ps.length} ${ps.length===1?'envío pendiente':'envíos pendientes'}` : 'Sin envíos pendientes.';
  const lista = $('lista');
  if (!ps.length) { lista.innerHTML = '<p class="vacio">Todo lo guardado ha recibido respuesta.</p>'; return; }
  lista.replaceChildren(...ps.map((p) => {
    const item = document.createElement('div');
    item.className = 'item';
    const titulo = document.createElement('strong');
    titulo.textContent = `${p.acta.acta} · v${p.acta.version}`;
    const idem = document.createElement('span');
    idem.textContent = p.acta.idem;
    const estado = document.createElement('small');
    estado.textContent = `${p.intentos} intentos${p.ultimoError ? ` · ${p.ultimoError}` : ' · esperando transmisión'}`;
    item.append(titulo, idem, estado);
    return item;
  }));
}
async function procesar(): Promise<void> {
  if (procesando || !navigator.onLine) return;
  procesando = true;
  try {
    for (const p of await todos()) {
      if (Date.now() < p.proximo) continue;
      try {
        const r = await enviar(p.acta, p.credencial);
        if (r.motivo === 'NO_AUTORIZADO') {
          // No se descarta el acta: se espera una credencial válida.
          await guardar({...p,intentos:p.intentos+1,proximo:Date.now()+30000,ultimoError:'credencial no válida: actualícela'});
          aviso(r.detalle ?? 'La credencial no es válida.');
        } else if (esEstadoFinal(r.estado)) {
          await borrar(p.acta.idem);
          aviso(`${r.estado}: ${r.detalle ?? ''}${r.recibo?` Recibo ${r.recibo.recibo}.`:''}`, r.estado !== 'RECHAZADA');
        } else {
          await guardar({...p,intentos:p.intentos+1,proximo:Date.now()+(r.reintentar_en_ms ?? 2000),ultimoError:r.estado});
        }
      } catch {
        const espera = Math.min(30000,1000*2**Math.min(p.intentos,5));
        await guardar({...p,intentos:p.intentos+1,proximo:Date.now()+Math.random()*espera,ultimoError:'reintento automático'});
      }
      await renderLista();
    }
  } finally { procesando = false; }
}
function aviso(texto: string, ok=false): void {
  const caja = document.createElement('div');
  caja.className = `aviso ${ok ? 'ok' : ''}`;
  caja.textContent = texto;
  $('aviso').replaceChildren(caja);
}
function programar(): void { clearTimeout(temporizador); temporizador=setTimeout(()=>{void procesar();programar();},3000); }

for (const input of document.querySelectorAll<HTMLInputElement>('[data-voto]')) input.addEventListener('input',()=>{
  $('total').textContent=`Total: ${[...document.querySelectorAll<HTMLInputElement>('[data-voto]')].reduce((s,i)=>s+Number(i.value||0),0)}`;
});
$('form').addEventListener('submit',async(ev)=>{
  ev.preventDefault();
  const valor = Object.fromEntries(campos.map(c=>[c,$<HTMLInputElement>(c).value]));
  const votos = Object.fromEntries(CASILLAS.map(c=>[c,Number($<HTMLInputElement>(`v-${c}`).value)]));
  const sufragantes = Object.values(votos).reduce((s,n)=>s+n,0);
  const acta = {...valor,mesa:Number(valor.mesa),puesto:Number(valor.puesto),municipio:Number(valor.municipio),version:Number(valor.version),ts_cierre:Math.floor(Date.now()/1000),votos,sufragantes,hash_foto:`local-${nuevoIdem()}`,idem:nuevoIdem()} as unknown as Acta;
  const v = validarActa(acta);
  if (!v.ok) { aviso(v.errores.join(' · ')); return; }
  await guardar({acta:v.acta,intentos:0,proximo:0,...(credencial?{credencial}:{})});
  aviso('Guardado en el dispositivo. La transmisión continuará automáticamente.',true);
  await renderLista(); void procesar();
});
$('credencial').addEventListener('change', async () => {
  usarCredencial($<HTMLInputElement>('credencial').value);
  if (!credencial) return;
  // Las actas pendientes del mismo jurado pasan a la credencial nueva.
  const jurado = credencial.split('.')[1];
  for (const p of await todos()) {
    if (p.acta.jurado === jurado && p.credencial !== credencial) await guardar({ ...p, credencial, proximo: 0 });
  }
  await renderLista(); conectar(); void procesar();
});
$('reintentar').addEventListener('click',()=>{conectar();void procesar();});
window.addEventListener('online',()=>{conectar();actualizarRed();void procesar();});
window.addEventListener('offline',actualizarRed);
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('sw.js').then(async (registro) => {
    const activo = (await navigator.serviceWorker.ready).active ?? registro.active;
    const urls = performance.getEntriesByType('resource')
      .map((recurso) => recurso.name)
      .filter((url) => new URL(url).origin === location.origin);
    activo?.postMessage({ tipo: 'precargar', urls: [location.href, ...urls] });
  });
}
await renderLista(); conectar(); actualizarRed(); programar(); void procesar();
