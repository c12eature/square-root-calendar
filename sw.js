// Square Root Calendar — DECOMMISSIONED (temporarily). This replaces the caching
// service worker: it deletes every cache, stops controlling pages, and unregisters
// itself, so no previously-installed copy can keep serving the app offline. It never
// serves anything from cache — all requests go straight to the network (the "temporarily
// unavailable" page). It does NOT touch localStorage, so user data survives a relaunch.
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){
  e.waitUntil((async function(){
    try{ var ks = await caches.keys(); await Promise.all(ks.map(function(k){ return caches.delete(k); })); }catch(e){}
    try{ await self.registration.unregister(); }catch(e){}
    try{ var cs = await self.clients.matchAll(); cs.forEach(function(c){ try{ c.navigate(c.url); }catch(e){} }); }catch(e){}
  })());
});
// network-only: never serve a cached response
self.addEventListener('fetch', function(e){ /* no respondWith → default network fetch */ });
