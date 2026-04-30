/**
 * SoyPekun — Service Worker
 * Estrategia: Cache First para assets estáticos, Network First para API calls
 */

const CACHE_NAME = "soypekun-v1";
const STATIC_CACHE = "soypekun-static-v1";

// Assets a pre-cachear al instalar
const PRECACHE_ASSETS = [
  "/",
  "/index.html",
];

// ── Install: pre-cachear assets estáticos ───────────────────────────────────
self.addEventListener("install", (event) => {
  console.log("[SW] Instalando SoyPekun Service Worker...");
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: limpiar caches viejas ─────────────────────────────────────────
self.addEventListener("activate", (event) => {
  console.log("[SW] Activando...");
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: estrategia según tipo de request ──────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar requests no-GET y requests a Firestore/Google APIs
  // (Firestore tiene su propio offline con IndexedDB)
  if (request.method !== "GET") return;
  if (url.hostname.includes("firestore.googleapis.com")) return;
  if (url.hostname.includes("firebase")) return;
  if (url.hostname.includes("googleapis.com")) return;

  // Para assets del bundle de Vercel/Vite (JS, CSS, imágenes) → Cache First
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".ico") ||
    url.pathname.endsWith(".svg")
  ) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (!response || response.status !== 200 || response.type !== "basic") {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        }).catch(() => cached); // Si falla la red y hay caché, usar caché
      })
    );
    return;
  }

  // Para la página principal → Network First, fallback a caché
  if (
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname.startsWith("/")
  ) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (!response || response.status !== 200) return response;
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request).then(cached =>
            cached || caches.match("/index.html")
          )
        )
    );
    return;
  }
});

// ── Escuchar mensajes de la app ──────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data?.type === "GET_VERSION") {
    event.source.postMessage({ type: "VERSION", version: CACHE_NAME });
  }
});

// ── Background sync (cuando vuelve internet) ─────────────────────────────────
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-campo") {
    console.log("[SW] Background sync triggered");
    // La app maneja el sync cuando detecta 'online' — el SW solo lo registra
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: "SYNC_REQUESTED" })
        );
      })
    );
  }
});
