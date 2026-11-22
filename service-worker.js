const CACHE_NAME="van-stock-pro-offline-v3";
const SHELL=["./","./index.html","./cloud-auth.js","./reference-library.js","./supabase-config.js"];
self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith("van-stock-pro-offline-")&&key!==CACHE_NAME).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin){
    // Cache the Supabase client module and its esm.sh module dependencies only.
    // Never cache Supabase API/auth responses or other user data.
    if(url.hostname==="esm.sh"){
      event.respondWith((async()=>{
        const cache=await caches.open(CACHE_NAME);
        const cached=await cache.match(request);
        if(cached)return cached;
        const response=await fetch(request);
        if(response&&response.ok)try{await cache.put(request,response.clone())}catch{}
        return response;
      })());
    }
    return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    try{
      const response=await fetch(request);
      if(response&&response.ok&&(request.mode==="navigate"||/\\.(?:html|js|css)$/.test(url.pathname))){
        try{await cache.put(request,response.clone())}catch{}
      }
      return response;
    }catch(error){
      const cached=await cache.match(request,{ignoreSearch:true});
      if(cached)return cached;
      if(request.mode==="navigate"){
        const shell=await cache.match("./index.html");
        if(shell)return shell;
      }
      throw error;
    }
  })());
});
