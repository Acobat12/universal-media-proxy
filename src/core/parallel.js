import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { assertPublicUrl, validRange } from './security.js';
import { pinnedFetch } from './transport.js';
import { fail } from './errors.js';

const pause = ms => new Promise(r => setTimeout(r, ms));
export function parseRequestedRange(raw, total) {
  if (!raw) return [0, total - 1, 200];
  validRange(raw);
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  let start, end;
  if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1; }
  else { const n = Number(m[2]); start = Math.max(0, total - n); end = total - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total || (m[1] === '' && Number(m[2]) === 0)) fail(416, 'Range not satisfiable');
  return [start, end, 206];
}

export function createAudioCache({ maxBytes = 64 * 1024 * 1024, ttlMs = 10 * 60 * 1000 } = {}) {
  const entries = new Map(); let used = 0;
  function prune() {
    for (const [key, entry] of entries) if (entry.until <= Date.now() && !entry.pending) { used -= entry.buffer.length; entries.delete(key); }
  }
  return {
    async get(key, loader) {
      prune(); const hit = entries.get(key);
      if (hit) return hit.pending || hit.buffer;
      const entry = { pending: null, buffer: null, until: Date.now() + ttlMs };
      entry.pending = Promise.resolve().then(loader).then(buffer => {
        if (buffer.length > maxBytes) { entries.delete(key); return buffer; }
        prune();
        for (const [k, v] of entries) {
          if (used + buffer.length <= maxBytes) break;
          if (k !== key && !v.pending) { used -= v.buffer.length; entries.delete(k); }
        }
        entry.buffer = buffer; entry.pending = null; entry.until = Date.now() + ttlMs;
        used += buffer.length; return buffer;
      }).catch(err => { entries.delete(key); throw err; });
      entries.set(key, entry); return entry.pending;
    },
    clear() { entries.clear(); used = 0; },
    stats() { prune(); return { entries: entries.size, bytes: used }; }
  };
}

export async function parallelAudio(req, res, source, {
  fetcher = pinnedFetch, validateUrl = assertPublicUrl, allowedHosts,
  threads = 8, chunkBytes = 512 * 1024, maxBytes = 1024 ** 3,
  cache = null, diskCache = null, cacheKey = '', cacheMaxFileBytes = 32 * 1024 ** 2,
  retries = 3, onBytes = () => {}, idleTimeoutMs = 30000
} = {}) {
  threads = Math.max(1, Math.min(threads, 24));
  chunkBytes = Math.max(64 * 1024, Math.min(chunkBytes, 4 * 1024 ** 2));
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  const candidates = await Promise.all(source.upstreams.slice(0, 8).map(u => validateUrl(u, allowedHosts)));
  if (!candidates.length) fail(502, 'No audio CDN');
  const headers = { 'Accept-Encoding': 'identity', ...(source.headers || {}) };
  const download = async (start, end, total) => {
    let last;
    for (let attempt = 0; attempt < Math.max(retries, candidates.length); attempt++) {
      if (controller.signal.aborted) throw Error('Client disconnected');
      const cdn = candidates[attempt % candidates.length];
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(); controller.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), idleTimeoutMs);
      try {
        const r = await fetcher(cdn, { method: 'GET', headers: { ...headers, Range: `bytes=${start}-${end}` }, signal: ctrl.signal });
        const cr = r.headers.get('content-range');
        if (r.status !== 206 || cr !== `bytes ${start}-${end}/${total}`) throw Error(`Invalid CDN range: ${r.status} ${cr}`);
        const ct = r.headers.get('content-type') || '';
        if (/^(text\/|application\/json)/i.test(ct)) throw Error('Non-media CDN response');
        const body = await new Response(r.body).arrayBuffer();
        const data = Buffer.from(body);
        if (data.length !== end - start + 1) throw Error('Incomplete CDN chunk');
        return data;
      } catch (e) { last = e; if (attempt + 1 < Math.max(retries, candidates.length)) await pause(Math.min(250 * (attempt + 1), 1000)); }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); ctrl.abort(); }
    }
    throw last;
  };
  try {
    let total;
    for (const cdn of candidates) {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), idleTimeoutMs);
      try {
        const r = await fetcher(cdn, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, signal: ctrl.signal });
        const m = /^bytes 0-0\/(\d+)$/.exec(r.headers.get('content-range') || '');
        await r.body?.cancel();
        if (r.status !== 206 || !m) continue;
        total = Number(m[1]); if (!Number.isSafeInteger(total) || total <= 0) continue;
        break;
      } catch { /* try another CDN */ }
      finally { clearTimeout(timer); ctrl.abort(); }
    }
    if (!total) fail(502, 'CDN does not support byte ranges');
    if (total > maxBytes) fail(413, 'Media exceeds configured limit');
    const [start, end, status] = parseRequestedRange(req.headers.range, total);
    const length = end - start + 1;
    const build = async (emit, first = start, last = end) => {
      // A bounded window: no more than `threads` chunks resident at once.
      for (let offset = first; offset <= last; offset += threads * chunkBytes) {
        const tasks = [];
        for (let i = 0; i < threads; i++) {
          const from = offset + i * chunkBytes;
          if (from > last) break;
          tasks.push(download(from, Math.min(from + chunkBytes - 1, last), total));
        }
        const chunks = await Promise.all(tasks);
        for (const chunk of chunks) await emit(chunk);
      }
    };
    let buffer;
    let diskLease;
    if (cache && total <= cacheMaxFileBytes && req.method !== 'HEAD') {
      buffer = await cache.get(cacheKey, async () => {
        const parts = []; await build(async chunk => { parts.push(chunk); }, 0, total - 1); return Buffer.concat(parts, total);
      });
    }
    if (diskCache && req.method !== 'HEAD') {
      diskLease = await diskCache.acquire(cacheKey, total, async path => {
        const file = createWriteStream(path, { flags: 'wx', mode: 0o600 });
        try {
          await build(async chunk => {
            if (!file.write(chunk)) await once(file, 'drain');
          }, 0, total - 1);
          file.end();
          await finished(file);
        } catch (err) { file.destroy(); throw err; }
      });
    }
    res.statusCode = status;
    res.setHeader('Content-Type', source.contentType || 'audio/mp4');
    res.setHeader('Content-Length', length);
    res.setHeader('Accept-Ranges', 'bytes');
    if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') { res.end(); return; }
    const emit = async chunk => { onBytes(chunk.length); if (!res.write(chunk)) await once(res, 'drain'); };
    try {
      if (diskLease) {
        const file = createReadStream(diskLease.path, { start, end });
        try {
          for await (const chunk of file) {
            if (controller.signal.aborted) throw Error('Client disconnected');
            await emit(chunk);
          }
        } finally { file.destroy(); }
      } else if (buffer) await emit(buffer.subarray(start, end + 1));
      else await build(emit);
      res.end();
    } finally { if (diskLease) { await diskLease.release(); diskLease = null; } }
  } catch (err) { if (res.headersSent) res.destroy(err); else throw err; }
  finally { res.off('close', abort); controller.abort(); }
}
