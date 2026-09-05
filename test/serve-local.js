// Serves www/ as the app origin, and /mobile-data/dg.db as the download host — one server, two
// roles, so the page can fetch the database same-origin without CORS getting in the way.
const http=require('http'),fs=require('fs'),path=require('path');
const WWW=process.argv[2], DIST=process.argv[3], PORT=+(process.argv[4]||8097);
const T={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.woff':'font/woff'};
http.createServer((q,r)=>{
  const u=decodeURIComponent(q.url.split('?')[0]);
  let f = u.startsWith('/mobile-data/') ? path.join(DIST, u.slice('/mobile-data/'.length)) : path.join(WWW, u);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()) f=path.join(WWW,'index.html');
  const h={'Content-Type':T[path.extname(f)]||'application/octet-stream','Content-Length':fs.statSync(f).size};
  r.writeHead(200,h); fs.createReadStream(f).pipe(r);
}).listen(PORT,()=>console.log('up',PORT));
