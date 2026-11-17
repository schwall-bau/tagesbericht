// Service Worker: macht die App offline nutzbar (Baustelle ohne Netz).
// Bei jeder neuen Version VERSION erhöhen, damit die Handys das Update laden.
const VERSION = 'tb-1.0.0';
const FILES = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'vendor/jspdf.umd.min.js', 'vendor/html2canvas.min.js', 'vendor/xlsx.mini.min.js',
  'icons/logo-dark.png', 'icons/logo-white.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // stammdaten.json immer zuerst aus dem Netz (falls vorhanden), sonst Cache
  if (req.url.endsWith('stammdaten.json')) {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); return r; }).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
