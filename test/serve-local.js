// Serves www/ as the app origin, and /mobile-data/dg.db as the download host — one server, two
// roles, so the page can fetch the database same-origin without CORS getting in the way.
//
// The MIME table below deliberately has NO entry for .mjs. It used to, and that one line hid a bug
// that broke the whole app on a real device: Android's MimeTypeMap has no "mjs" either, so
// Capacitor served the core bundle as application/octet-stream and the module worker refused to
// import it. This server must never be more permissive than the device it stands in for — an
// extension missing here falls through to application/octet-stream, exactly as it would there.
const http=require('http'),fs=require('fs'),path=require('path');
const WWW=process.argv[2], DIST=process.argv[3], PORT=+(process.argv[4]||8097);
const T={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.woff':'font/woff'};
// Paths follow Capacitor's WebViewLocalServer, not a forgiving SPA server: "/" and any path whose
// last segment has no dot get the ROOT index.html (even a real folder like /memo/), and a dotted
// path with no file behind it fails (the device shows ERR_INVALID_RESPONSE). Falling back to
// index.html for everything hid /an3.57:1.3 links that were dead on the tablet.
http.createServer((q,r)=>{
  const u=decodeURIComponent(q.url.split('?')[0]);
  const last=u.replace(/\/+$/,'').split('/').pop();
  let f = u.startsWith('/mobile-data/') ? path.join(DIST, u.slice('/mobile-data/'.length))
    : !last.includes('.') ? path.join(WWW, 'index.html') : path.join(WWW, u);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){ r.writeHead(404); return r.end(); }
  const h={'Content-Type':T[path.extname(f)]||'application/octet-stream','Content-Length':fs.statSync(f).size};
  r.writeHead(200,h); fs.createReadStream(f).pipe(r);
}).listen(PORT,()=>console.log('up',PORT));
