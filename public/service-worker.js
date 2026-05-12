/**
 * SoyPekun — Service Worker
 * Cachea el bundle de la app para que funcione sin internet.
 * Los datos (Firestore) tienen su propio cache via IndexedDB.
 */
 
const CACHE = "soypekun-v2";
 
// Al instalar: cachear la página principal
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(["/", "/index.html"])).then(() => self.skipWaiting())
  );
});
 
// Al activar: limpiar caches viejas
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
 
// Fetch: Cache First para assets, Network First para la página
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
 
  // No interceptar Firestore, Firebase, APIs externas
  if (
    e.request.method !== "GET" ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("firebase") ||
    url.hostname.includes("anthropic") ||
    url.pathname.includes("/api/")
  ) return;
 
  // Assets del bundle (JS, CSS, imágenes) → Cache First
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".ico")
  ) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (!res || res.status !== 200) return res;
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        });
      })
    );
    return;
  }
 
  // Página principal → Network First, fallback a caché
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (!res || res.status !== 200) return res;
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then(c => c || caches.match("/index.html")))
  );
});
 
// Mensaje de la app (ej: nueva versión disponible)
self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
});
 
