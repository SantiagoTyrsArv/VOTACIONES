const CACHE = 'actas-v3';
// Rutas relativas al Service Worker: funciona en / (desarrollo) y en /jurado/ (servida por la instancia).
const RAIZ = new URL('./', self.location).href;
const BASE = [RAIZ, new URL('manifest.webmanifest', RAIZ).href, new URL('icono.svg', RAIZ).href];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (event) => {
  if (event.data?.tipo !== 'precargar' || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((url) => typeof url === 'string' && new URL(url).origin === self.location.origin);
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.allSettled(urls.map((url) => cache.add(url)))));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/actas') || url.pathname.startsWith('/ws/')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(event.request, { ignoreVary: true });
      if (cached) return cached;
      if (event.request.mode === 'navigate') return (await caches.match(RAIZ)) || Response.error();
      return Response.error();
    }
  })());
});
