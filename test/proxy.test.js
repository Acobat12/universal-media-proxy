import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { proxyAudio } from '../src/core/proxy.js';

// Proxy integration with public DNS hostname; fetcher is deterministic and offline.
test('streams 206 byte ranges without buffering entire media', async () => {
  const bytes = Buffer.from('abcdefghij');
  const upstream = async (_url, opts) => {
    assert.equal(opts.headers.Range, 'bytes=2-5');
    return new Response(bytes.subarray(2, 6), { status: 206, headers: { 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4', 'Accept-Ranges': 'bytes' } });
  };
  const server = createServer((req, res) => proxyAudio(req, res, { upstreams: ['https://example.com/a.m4s'], contentType: 'audio/mp4' }, { fetcher: upstream, allowedHosts: ['example.com'], validateUrl: async u => new URL(u) }).catch(e => { res.statusCode = 500; res.end(e.message); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const resp = await fetch(`http://127.0.0.1:${server.address().port}/media`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await resp.text(), 'cdef');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
