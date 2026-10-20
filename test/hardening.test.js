import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { proxyAudio } from '../src/core/proxy.js';
async function check(upstream, range) {
  const server = createServer((req,res) => proxyAudio(req,res,{upstreams:['https://cdn.example.com/a.m4s'],contentType:'audio/mp4'},{fetcher:upstream,allowedHosts:['example.com'],validateUrl:async x=>new URL(x),retries:0}).catch(e=>{if(!res.headersSent){res.statusCode=e.status||502;res.end(e.message);}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try { return await fetch(`http://127.0.0.1:${server.address().port}`,{headers:range?{Range:range}:{}}).then(async r=>({status:r.status,body:await r.text()})); }
  finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
test('rejects mismatched Content-Range', async()=>{
  const r=await check(async()=>new Response('abcd',{status:206,headers:{'Content-Type':'audio/mp4','Content-Range':'bytes 2-5/10','Content-Length':'4'}}),'bytes=0-3');
  assert.equal(r.status,502);
});
test('rejects partial response whose total size exceeds configured maximum', async()=>{
  const r=await check(async()=>new Response('abcd',{status:206,headers:{'Content-Type':'audio/mp4','Content-Range':'bytes 0-3/999999999999','Content-Length':'4'}}),'bytes=0-3');
  assert.equal(r.status,413);
});
test('rejects HTML from upstream',async()=>{
  const r=await check(async()=>new Response('<html></html>',{headers:{'Content-Type':'text/html'}}));
  assert.equal(r.status,502);
});
