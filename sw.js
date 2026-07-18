// Square Root Calendar — service worker. Bump CACHE whenever assets change.
var CACHE = 'sqrtcal-v6';
var ASSETS = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'
];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.map(function(k){ if(k !== CACHE) return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;
  var isDoc = req.mode === 'navigate' || req.destination === 'document';
  if(isDoc){
    // network-first for the page → always the latest when online, cached shell when offline
    e.respondWith(
      fetch(req).then(function(res){
        if(res && res.status === 200){ var cl = res.clone(); caches.open(CACHE).then(function(c){ c.put('/', cl); }); }
        return res;
      }).catch(function(){ return caches.match(req).then(function(c){ return c || caches.match('/'); }); })
    );
    return;
  }
  // static assets (icons, manifest) → cache-first, refresh in the background
  e.respondWith(
    caches.match(req).then(function(cached){
      var net = fetch(req).then(function(res){
        if(res && res.status === 200 && res.type === 'basic'){ var cl = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, cl); }); }
        return res;
      }).catch(function(){ return cached; });
      return cached || net;
    })
  );
});
