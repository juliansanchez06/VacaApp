/**
 * SoyPekun — Service Worker v3
 * Limpia caches viejas y se actualiza solo.
 */
 
const CACHE = "soypekun-v3";
 
self.addEventListener("install", (e) => {
  e.waitUntil(self.skipWaiting());
});
 
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
 
// Sin cache por ahora — pasa todo a la red
self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
 
