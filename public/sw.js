// Service worker GAP : l'interface s'ouvre même hors connexion (dernière version connue),
// les données sont toujours demandées au réseau d'abord, le cache ne sert qu'en secours.
const VERSION = 'gap-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const networkFirst = async req => {
  const cache = await caches.open(VERSION);
  try { const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res; }
  catch (e) { const hit = await cache.match(req, { ignoreSearch: true }); if (hit) return hit; throw e; }
};
const cacheFirst = async req => {
  const cache = await caches.open(VERSION), hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res;
};

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // Page et données : réseau d'abord (toujours les alertes les plus récentes), cache si hors ligne
    e.respondWith(networkFirst(req));
  } else if (/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
    // Bibliothèques versionnées et polices : cache d'abord
    e.respondWith(cacheFirst(req));
  }
});
