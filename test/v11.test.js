import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { proxyAudio } from '../src/core/proxy.js';
import { bilibili } from '../src/adapters/bilibili.js';

async function runProxy(upstream, request = {}) {
  const server = createServer((req, res) => proxyAudio(req, res, { upstreams: ['https://a.bilivideo.com/old.m4s'], contentType: 'audio/mp4' }, {
    fetcher: upstream, allowedHosts: ['bilivideo.com'], validateUrl: async u => new URL(u), ...request
  }).catch(e => { if (!res.headersSent) { res.statusCode = e.status || 500; res.end(e.message); } }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/media` };
}
const stop = async server => { server.closeAllConnections(); await new Promise(r => server.close(r)); };

test('HEAD remains HEAD upstream', async () => {
  let method;
  const { server, url } = await runProxy(async (_url, opts) => { method = opts.method; return new Response(null, { status: 200, headers: { 'Content-Length': '10', 'Accept-Ranges': 'bytes' } }); });
  try { const r = await fetch(url, { method: 'HEAD' }); assert.equal(r.status, 200); assert.equal(method, 'HEAD'); assert.equal(r.headers.get('content-length'), '10'); } finally { await stop(server); }
});

test('falls back to second CDN after first upstream error', async () => {
  const calls = [];
  const { server, url } = await runProxy(async target => { calls.push(target.href); return target.href.includes('old') ? new Response('bad', { status: 503 }) : new Response('ok', { status: 200, headers: { 'Content-Type': 'audio/mp4' } }); }, { retries: 0, refreshSource: async () => ({ upstreams: ['https://b.bilivideo.com/new.m4s'], contentType: 'audio/mp4' }) });
  try { const r = await fetch(url); assert.equal(await r.text(), 'ok'); assert.equal(calls.length, 2); } finally { await stop(server); }
});

test('Bilibili quality selection chooses lowest track', async () => {
  const fetcher = async u => ({ ok: true, json: async () => u.includes('/pagelist?') ? { code: 0, data: { pages: [{ cid: 42 }] } } : { code: 0, data: { dash: { audio: [{ bandwidth: 80, baseUrl: 'https://a.bilivideo.com/hi' }, { bandwidth: 20, baseUrl: 'https://a.bilivideo.com/low' }] } } } });
  const s = await bilibili.resolve(new URL('https://www.bilibili.com/video/BV1xx411c7mD'), { fetcher, quality: 'lowest' });
  assert.equal(s.upstreams[0], 'https://a.bilivideo.com/low');
});

test('rejects malformed Content-Range from CDN', async () => {
  const { server, url } = await runProxy(async () => new Response('abcd', { status: 206, headers: { 'Content-Range': 'nonsense' } }), { retries: 0 });
  try { const r = await fetch(url, { headers: { Range: 'bytes=0-3' } }); assert.equal(r.status, 502); } finally { await stop(server); }
});
