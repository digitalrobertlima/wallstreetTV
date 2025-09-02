/*
  Service Worker for WallStreetTV Crypto
  - Cache static shell for offline startup
  - SWR (stale-while-revalidate) leve para GET de APIs públicas, com TTL curto
*/
const VERSION = 'v0.0.10';
const STATIC_CACHE = `wstv-static-${VERSION}`;
const STATIC_ASSETS = [
  './', // index.html
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './markets.html',
  './markets.js',
  './chart.html',
  './chart.js',
  './offline.html'
  // Note: icons are data URLs; nothing else to pre-cache
];
const API_TTL_MS = 30 * 1000; // 30s de validade das respostas de API
const API_CACHE = `wstv-api-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
  caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clean older static caches
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== STATIC_CACHE && k.startsWith('wstv-static-') ? caches.delete(k) : undefined)));
      // Enable navigation preload for faster network-first navigations
      try{ if(self.registration && self.registration.navigationPreload){ await self.registration.navigationPreload.enable(); } }catch{}
      await self.clients.claim();
    })()
  );
});

// Helper: race fetch with timeout
function fetchWithTimeout(req, ms = 8000) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    fetch(req, { signal: ctrl.signal, cache: 'no-store' })
      .then((res) => {
        clearTimeout(id);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(id);
        reject(err);
      });
  });
}

function isApi(url){
  return (
    url.origin.includes('bitpreco.com') ||
    url.origin.includes('binance.com') ||
    url.origin.includes('open-meteo.com') ||
    url.origin.includes('coingecko.com') ||
    url.origin.includes('exchangerate.host') ||
    url.origin.includes('bitstamp.net')
  );
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin navigations and static files
  const isSameOrigin = url.origin === self.location.origin;
  const isNavigate = event.request.mode === 'navigate';
  const dest = event.request.destination;
  // Network-first for navigations and app shell assets, with cache fallback per-request
  if (isSameOrigin && (isNavigate || dest === 'document')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      try{
        const preload = event.preloadResponse ? await event.preloadResponse : undefined;
        const netRes = preload || await fetchWithTimeout(event.request, 8000);
        if(netRes && netRes.ok){
          try{ await cache.put(event.request, netRes.clone()); }catch{}
        }
        return netRes;
      }catch{
        // Try exact page cache first, then fall back to index, then to offline page
        const cachedExact = await cache.match(event.request);
        if(cachedExact) return cachedExact;
        const cachedIndex = await cache.match('./');
        if(cachedIndex) return cachedIndex;
        const cachedOffline = await cache.match('./offline.html');
        if(cachedOffline) return cachedOffline;
        return new Response('<h1>Offline</h1><p>Tente novamente quando a conexão voltar.</p>', { headers: { 'Content-Type':'text/html; charset=utf-8' }, status: 503 });
      }
    })());
    return;
  }
  if (isSameOrigin && (dest === 'script' || dest === 'style' || dest === 'font' || dest === 'image')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      try{
        const res = await fetchWithTimeout(event.request, 8000);
        if(res && res.ok){ try{ await cache.put(event.request, res.clone()); }catch{} }
        return res;
      }catch{
        const cached = await cache.match(event.request);
        if(cached) return cached;
        throw new Error('offline');
      }
    })());
    return;
  }
  // SWR para APIs GET: entregar cache fresco (<= TTL) quando disponível, e revalidar ao fundo
  if(event.request.method === 'GET' && isApi(url)){
    event.respondWith((async () => {
      const cache = await caches.open(API_CACHE);
      const cached = await cache.match(event.request);
      const now = Date.now();
      let cachedAgeOk = false;
      if(cached){
        // Preferir header custom X-Fetched-At; se ausente, cair para Date
        const fetchedAt = Number(cached.headers.get('X-Fetched-At') || '0');
        if(fetchedAt && (now - fetchedAt) <= API_TTL_MS) {
          cachedAgeOk = true;
        } else {
          const date = cached.headers.get('date');
          const ts = date ? Date.parse(date) : 0;
          if(ts && (now - ts) <= API_TTL_MS) cachedAgeOk = true;
        }
      }
      const networkPromise = fetchWithTimeout(event.request, 6000).then(async (res) => {
        try{
          if(res && res.ok){
            const stamped = await stampResponse(res);
            await cache.put(event.request, stamped.clone());
          }
        }catch{}
        return res;
      }).catch(() => undefined);
      if(cached && cachedAgeOk){
        // devolve o cache "fresco" e atualiza ao fundo
        networkPromise; // dispara sem await
        return cached;
      }
      // caso sem cache ou expirado: tenta rede, cai para cache mesmo velho se existir
      const net = await networkPromise;
      if(net) return net;
      if(cached) return cached;
      // fallback padrão
      return fetch(event.request);
    })());
    return;
  }
});

// Warmup: prefetch and refresh static assets on demand
self.addEventListener('message', (event) => {
  const data = event.data;
  if(!data || typeof data !== 'object') return;
  if(data.type === 'SKIP_WAITING'){
    self.skipWaiting();
    return;
  }
  if(data.type === 'warmup'){
    event.waitUntil((async () => {
      try{
        const cache = await caches.open(STATIC_CACHE);
        await Promise.all(STATIC_ASSETS.map(async (path) => {
          try{
            const res = await fetchWithTimeout(path, 8000);
            if(res && res.ok){ await cache.put(path, res.clone()); }
          }catch{ /* ignore single asset failures */ }
        }));
      }catch{ /* ignore */ }
    })());
  }
});

// Cria uma resposta com header X-Fetched-At para controle de frescor
async function stampResponse(res){
  try{
    const ab = await res.clone().arrayBuffer();
    const headers = new Headers(res.headers);
    headers.set('X-Fetched-At', String(Date.now()));
    return new Response(ab, { status: res.status, statusText: res.statusText, headers });
  }catch{
    // fallback: retorna o original se der erro para não quebrar fluxo
    return res;
  }
}
