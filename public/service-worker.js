/**
 * SoyPekun — Service Worker v4
 * NO cachea el HTML/JS de la app → siempre toma la última versión de Vercel.
 * Esto evita que quedes con una versión vieja después de un deploy.
 */
const CACHE = "soypekun-v4";

self.addEventListener("install", (e) => {
  // Activar de inmediato la nueva versión, sin esperar
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))  // borra TODO cache viejo
      .then(() => self.clients.claim())
  );
});

// Network-first: siempre intenta traer lo último de la red.
// Solo usa cache como fallback si no hay internet.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Guardar copia para offline
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      })
      .catch(() => caches.match(e.request))  // sin internet → lo último cacheado
  );
});
