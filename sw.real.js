// Square Root Calendar — REAL service worker (caching + Web Push).
// The deployed /sw.js stays the kill switch while the app is OFF. At relaunch:
//   cp sw.real.js sw.js   (then bump CACHE if assets changed) and push.
// Bump CACHE whenever assets change.
var CACHE = 'sqrtcal-v9';
var ASSETS = [
  '/', '/index.html', '/manifest.webmanifest', '/boxdata.js',
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
  if(req.url.indexOf('/api/') !== -1) return;   // cloud/house API is always live network — never cache it
  var isDoc = req.mode === 'navigate' || req.destination === 'document';
  if(isDoc){
    e.respondWith(
      fetch(req).then(function(res){
        if(res && res.status === 200){ var cl = res.clone(); caches.open(CACHE).then(function(c){ c.put('/', cl); }); }
        return res;
      }).catch(function(){ return caches.match(req).then(function(c){ return c || caches.match('/'); }); })
    );
    return;
  }
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

// ---- Web Push (House Calendar requests) ----
self.addEventListener('push', function(e){
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: (e.data && e.data.text && e.data.text()) || '' }; }
  var title = data.title || 'Square Root Calendar';
  var opts = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    tag: data.tag || 'house-request',        // collapse repeats into one
    renotify: true,
    data: { url: data.url || '/?house=1' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/?house=1';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (var i = 0; i < list.length; i++){ var c = list[i]; if ('focus' in c){ c.postMessage({ house: true }); return c.focus(); } }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
