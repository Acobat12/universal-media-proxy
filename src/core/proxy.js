import { Readable } from 'node:stream';
import { once } from 'node:events';
import { assertPublicUrl, validRange } from './security.js';
import { fail } from './errors.js';
import { pinnedFetch } from './transport.js';

const PASS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function proxyAudio(req, res, source, {
  fetcher = pinnedFetch, allowedHosts, connectTimeoutMs = 15000, idleTimeoutMs = 30000,
  maxBytes = 1024 * 1024 * 1024, validateUrl = assertPublicUrl,
  refreshSource, retries = 1, onBytes = () => {}
} = {}) {
  const range = validRange(req.headers.range);
  let candidates = source.upstreams.slice(0, 8);
  let refreshed = false;
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, candidates.length) * (retries + 1) + 1; attempt++) {
    if (res.headersSent) return;
    if (attempt >= candidates.length * (retries + 1)) {
      if (!refreshed && refreshSource) {
        refreshed = true;
        const newer = await refreshSource();
        candidates = newer.upstreams.slice(0, 8);
        source = newer;
        attempt = -1;
        continue;
      }
      break;
    }
    const target = candidates[Math.floor(attempt / (retries + 1))];
    const ctrl = new AbortController();
    const onClose = () => ctrl.abort();
    res.once('close', onClose);
    let connectTimer = setTimeout(() => ctrl.abort(Error('Connection timeout')), connectTimeoutMs);
    let idleTimer;
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ctrl.abort(Error('Upstream idle timeout')), idleTimeoutMs); };
    try {
      const url = await validateUrl(target, allowedHosts);
      resetIdle();
      const headers = { 'Accept-Encoding': 'identity', ...(source.headers || {}) };
      if (range) headers.Range = range;
      // HEAD is forwarded as HEAD. A CDN which rejects HEAD may be handled by a Range probe later.
      const response = await fetcher(url, { method: req.method, headers, signal: ctrl.signal, redirect: 'manual', connectTimeoutMs });
      clearTimeout(connectTimer); connectTimer = null;
      if (![200, 206, 416].includes(response.status)) throw Error(`Upstream HTTP ${response.status}`);
      if (range && response.status === 200) throw Error('Upstream ignored Range');
      const contentRange = response.headers.get('content-range');
      const lengthRaw = response.headers.get('content-length');
      const length = lengthRaw === null ? null : Number(lengthRaw);
      if (length !== null && (!Number.isSafeInteger(length) || length < 0)) throw Error('Invalid Content-Length');
      let expectedLength = length;
      let totalSize = length;
      if (response.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');
        if (!m) throw Error('Invalid Content-Range');
        const [start, end, total] = m.slice(1).map(Number);
        if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) throw Error('Invalid Content-Range bounds');
        if (range) {
          const request = /^bytes=(\d*)-(\d*)$/.exec(range);
          const requestedStart = request[1] ? Number(request[1]) : Math.max(0, total - Number(request[2]));
          const requestedEnd = request[2] && request[1] ? Math.min(Number(request[2]), total - 1) : total - 1;
          if (start !== requestedStart || end !== requestedEnd) throw Error('CDN returned incorrect byte range');
        } else if (start !== 0) throw Error('Unexpected partial upstream response');
        expectedLength = end - start + 1;
        totalSize = total;
        if (length !== null && length !== expectedLength) throw Error('Content-Length disagrees with Content-Range');
      }
      if (response.status === 416 && !/^bytes \*\/\d+$/.test(contentRange || '')) throw Error('Invalid 416 Content-Range');
      if (totalSize !== null && totalSize > maxBytes) fail(413, 'Media exceeds configured limit');
      if (response.status !== 416 && req.method !== 'HEAD' && !response.body) throw Error('Empty upstream body');
      const contentType = response.headers.get('content-type') || '';
      if (/^(text\/html|application\/json|text\/plain)/i.test(contentType)) throw Error('CDN returned non-media content');
      // Set headers only after upstream validation, allowing fallback before response starts.
      res.statusCode = response.status;
      res.setHeader('Content-Type', source.contentType || 'audio/mp4');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      for (const name of PASS) { const v = response.headers.get(name); if (v) res.setHeader(name, v); }
      if (req.method === 'HEAD' || response.status === 416) { await response.body?.cancel(); res.end(); return; }
      const stream = Readable.fromWeb(response.body);
      let transferred = 0;
      resetIdle();
      for await (const chunk of stream) {
        resetIdle();
        transferred += chunk.length;
        if (transferred > maxBytes) { ctrl.abort(); res.destroy(Error('Transfer limit exceeded')); return; }
        onBytes(chunk.length);
        if (!res.write(chunk)) await once(res, 'drain');
      }
      clearTimeout(idleTimer);
      if (expectedLength !== null && transferred !== expectedLength) { res.destroy(Error('Incomplete upstream response')); return; }
      res.end(); return;
    } catch (err) {
      lastError = err;
     console.error('[PROXY ERROR]', {
  site: source.site,
  message: err?.message,
  code: err?.code,
  cause: err?.cause?.message,
  headersSent: res.headersSent
}); 
      if (res.headersSent) { res.destroy(err); return; }
      if (err.status && err.status < 500) throw err;
      if (attempt % (retries + 1) !== retries) await sleep(Math.min(500 * (attempt + 1), 1500));
    } finally {
      clearTimeout(connectTimer); clearTimeout(idleTimer); res.off('close', onClose);
    }
  }
  fail(502, `Upstream unavailable: ${lastError?.message || 'no candidates'}`);
}
