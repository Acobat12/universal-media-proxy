import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parallelAudio, createAudioCache, parseRequestedRange } from '../src/core/parallel.js';

const payload = Buffer.from('0123456789'.repeat(10000));
function fakeFetch(_url, { headers }) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
  const a = Number(m[1]), b = Number(m[2]);
  const body = payload.subarray(a, b + 1);
  return Promise.resolve({ status: 206, headers: new Headers({ 'content-range': `bytes ${a}-${b}/${payload.length}`, 'content-length': String(body.length), 'content-type': 'audio/mp4' }), body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }) });
}
class Response extends EventEmitter {
  headers = {}; chunks = []; headersSent = false;
  setHeader(k,v) { this.headers[k.toLowerCase()] = v; }
  write(b) { this.headersSent = true; this.chunks.push(Buffer.from(b)); return true; }
  end() { this.headersSent = true; this.emit('finish'); }
  destroy(e) { this.error = e; this.emit('close'); }
  data() { return Buffer.concat(this.chunks); }
}
const source = { upstreams: ['https://cdn.example/audio.m4s'], contentType: 'audio/mp4' };
const options = { fetcher: fakeFetch, validateUrl: async u => new URL(u), allowedHosts: ['cdn.example'], threads: 3, chunkBytes: 65536 };
test('parallel mode assembles exact bytes in order', async () => {
  const res = new Response(); await parallelAudio({ method: 'GET', headers: {} }, res, source, options);
  assert.deepEqual(res.data(), payload); assert.equal(res.headers['content-length'], payload.length);
});
test('parallel mode handles a range', async () => {
  const res = new Response(); await parallelAudio({ method: 'GET', headers: { range: 'bytes=500-2000' } }, res, source, options);
  assert.deepEqual(res.data(), payload.subarray(500,2001)); assert.equal(res.statusCode,206);
});
test('cached mode reuses full audio for subsequent ranges', async () => {
  let calls = 0;
  const fetcher = (...args) => { calls++; return fakeFetch(...args); };
  const cache = createAudioCache({ maxBytes: 200000, ttlMs: 10000 });
  const opt = { ...options, fetcher, cache, cacheKey: 'same', cacheMaxFileBytes: 200000 };
  const a = new Response(); await parallelAudio({ method: 'GET', headers: {} }, a, source, opt);
  const previous = calls;
  const b = new Response(); await parallelAudio({ method: 'GET', headers: { range: 'bytes=5-15' } }, b, source, opt);
  assert.deepEqual(b.data(), payload.subarray(5,16));
  assert.equal(calls, previous + 1); // range probe only
  assert.equal(cache.stats().entries,1);
});
test('range parser rejects unsatisfiable ranges', () => {
  assert.deepEqual(parseRequestedRange('bytes=-4', 100), [96,99,206]);
  assert.throws(() => parseRequestedRange('bytes=120-', 100));
});
