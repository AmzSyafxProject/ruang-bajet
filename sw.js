// Service worker ringkas: rangkaian dahulu, cache sebagai sandaran luar talian.
// Tidak menyimpan data pengguna — hanya fail aplikasi (HTML/CSS/JS/ikon).
const CACHE = 'ruang-bajet-shell-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'js/utils.js', 'js/db.js', 'js/store.js', 'js/backup.js', 'js/sync.js',
  'manifest.json', 'icon-192.png', 'apple-touch-icon.png', 'logo.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Firebase/fon: biar pelayar urus
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
