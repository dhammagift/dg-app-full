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
http.createServer((q,r)=>{
  const u=decodeURIComponent(q.url.split('?')[0]);
  let f = u.startsWith('/mobile-data/') ? path.join(DIST, u.slice('/mobile-data/'.length)) : path.join(WWW, u);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()) f=path.join(WWW,'index.html');
  const h={'Content-Type':T[path.extname(f)]||'application/octet-stream','Content-Length':fs.statSync(f).size};
  r.writeHead(200,h); fs.createReadStream(f).pipe(r);
}).listen(PORT,()=>console.log('up',PORT));
