// Service worker: offline app shell + Android "Share to Notes" target.
const CACHE = 'notes-v1';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Google APIs etc. go straight to network

  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;

  // Stale-while-revalidate: instant from cache, refresh in background.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = e.request.mode === 'navigate' ? './index.html' : e.request;
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('notes-db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('shared')) d.createObjectStore('shared', { autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const db = await openDB();
    const t = db.transaction('shared', 'readwrite');
    const store = t.objectStore('shared');
    const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n');
    if (text) store.add({ text });
    for (const f of form.getAll('images')) if (f && f.size) store.add({ file: f });
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  } catch (err) {
    console.error('share failed', err);
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}
