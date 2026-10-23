import { createVotGateway } from './vot-gateway.js';
import { prepareMediaTranslation } from './media-translation.js';
import http from 'node:http';
import { registry } from './core/adapter-loader.js';
import { parallelAudio, createAudioCache } from './core/parallel.js';
import { createDiskCache } from './core/disk-cache.js';
import { pinnedFetch } from './core/transport.js';
import { HttpError, fail } from './core/errors.js';
import { assertPublicUrl } from './core/security.js';
import { extractAudio } from './core/extraction.js';

const DEFAULT_HOSTS = [];
export function createHandler({ secret, publicBaseUrl, allowedHosts = DEFAULT_HOSTS, fetcher = fetch, mediaFetcher = pinnedFetch, ttlSeconds = 900, maxBytes = 1024 * 1024 * 1024, maxConcurrent = 4, fallbackEnabled = false, fallbackHosts = [], ytdlp, defaultMode = 'parallel', parallelThreads = 8, parallelChunkBytes = 524288, cacheMaxBytes = 67108864, cacheMaxFileBytes = 33554432, cacheTtlMs = 600000, diskCacheDir, diskCacheTtlMs = 900000, diskCacheMaxBytes = 1073741824, diskCacheMaxFileBytes = 268435456 } = {}) {
  if (!publicBaseUrl) throw Error('PUBLIC_BASE_URL required');
  const base = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw Error('Invalid PUBLIC_BASE_URL');
  // Adapter-declared CDN domains extend the trusted allowlist; DNS/IP checks still apply.
  const effectiveAllowedHosts = [...new Set([...allowedHosts, ...registry.adapters.flatMap(a => a.mediaHosts || [])])];
  const audioCache = createAudioCache({ maxBytes: cacheMaxBytes, ttlMs: cacheTtlMs });
  const diskCache = createDiskCache({ ...(diskCacheDir ? { directory: diskCacheDir } : {}), ttlMs: diskCacheTtlMs, maxBytes: diskCacheMaxBytes, maxFileBytes: diskCacheMaxFileBytes });
  let activeStreams = 0;
  return async function handler(req, res) {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, base);
      if (url.pathname === '/health' && req.method === 'GET') return send(200, { ok: true, adapters: registry.adapters.map(x => x.id) });
      if (url.pathname === '/api/resolve' && req.method === 'POST') {
        let size = 0; const parts = [];
        for await (const chunk of req) { size += chunk.length; if (size > 8192) fail(413, 'Request too large'); parts.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(parts).toString()); } catch { fail(400, 'Invalid JSON'); }
        let target; try { target = new URL(body.url); } catch { fail(400, 'Invalid URL'); }
        if (target.protocol !== 'https:' || target.username || target.password) fail(400, 'HTTPS URL required');
        const adapter = registry.find(target);
        if (typeof adapter.stableMediaPath !== 'function') fail(422, 'Adapter does not support stable media URLs');
        const quality = body.quality || 'best';
        const path = adapter.stableMediaPath(target, { quality });
        if (typeof path !== 'string' || !path.startsWith(`/media/${adapter.id}/`) || path.includes('?') || path.includes('#')) fail(500, 'Invalid adapter media path');
        return send(200, { site: adapter.id, mode: 'parallel', mediaUrl: new URL(path, base).href });
      }
      // Optional site-specific routes are owned by adapters, not the core server.
      for (const adapter of registry.adapters) {
        if (typeof adapter.handleRequest !== 'function') continue;
        const handled = await adapter.handleRequest({ req, res, url, base, send, fetcher, mediaFetcher,
          effectiveAllowedHosts, maxBytes, parallelThreads, parallelChunkBytes,
          assertPublicUrl, parallelAudio });
        if (handled) return;
      }
      if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method)) {
        const adapter = registry.adapters.find(a => typeof a.resolveMediaPath === 'function' && url.pathname.startsWith(`/media/${a.id}/`));
        if (!adapter) return send(404, { error: 'Unknown stable media route' });
        const source = await adapter.resolveMediaPath(url.pathname, { fetcher, signal: AbortSignal.timeout(20000) });
        if (!source || !Array.isArray(source.upstreams) || !source.upstreams.length) fail(404, 'Media not found');
        for (const candidate of source.upstreams) await assertPublicUrl(candidate, effectiveAllowedHosts);
        return parallelAudio(req, res, source, { fetcher: mediaFetcher, allowedHosts: effectiveAllowedHosts, maxBytes,
          threads: parallelThreads, chunkBytes: parallelChunkBytes, fallbackToStream: true,
          cache: audioCache, diskCache: adapter.id === 'bilibili' ? null : diskCache, cacheKey: url.pathname, cacheMaxFileBytes, onBytes: () => {} });
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS', 'Access-Control-Allow-Headers': 'Range' }); return res.end(); }
      return send(404, { error: 'Not found' });
    } catch (err) {
      if (res.headersSent) { res.destroy(err); return; }
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      return send(status, { error: status >= 500 ? 'Internal/upstream error' : err.message });
    }
  };
}
export function startServer(env = process.env) {
  const handler = createHandler({ publicBaseUrl: env.PUBLIC_BASE_URL, allowedHosts: (env.ALLOWED_UPSTREAM_HOSTS || DEFAULT_HOSTS.join(',')).split(',').map(s => s.trim()).filter(Boolean), maxBytes: Number(env.MAX_TRANSFER_BYTES || 1073741824), maxConcurrent: Number(env.MAX_CONCURRENT_STREAMS || 4), fallbackEnabled: env.ENABLE_YTDLP === 'true', fallbackHosts: (env.YTDLP_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), defaultMode: 'parallel', parallelThreads: Number(env.PARALLEL_THREADS || 8), parallelChunkBytes: Number(env.PARALLEL_CHUNK_BYTES || 524288), cacheMaxBytes: Number(env.CACHE_MAX_BYTES || 67108864), cacheMaxFileBytes: Number(env.CACHE_MAX_FILE_BYTES || 33554432), cacheTtlMs: Number(env.CACHE_TTL_MS || 600000), diskCacheDir: env.DISK_CACHE_DIR, diskCacheTtlMs: Number(env.DISK_CACHE_TTL_MS || 900000), diskCacheMaxBytes: Number(env.DISK_CACHE_MAX_BYTES || 1073741824), diskCacheMaxFileBytes: Number(env.DISK_CACHE_MAX_FILE_BYTES || 268435456) });
  const votGateway = env.ENABLE_VOT_PROXY === 'true' ? createVotGateway({ yandexApiUrl: env.YANDEX_API_URL, serverId: env.SERVER_ID, maxBodyBytes: Number(env.VOT_MAX_BODY_BYTES || 1048576) }) : null;
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url || '/', 'http://localhost').pathname;
    if (process.env.VOT_DIAGNOSTICS !== 'false' && req.method === 'POST' && p.includes('/video-translation/translate')) console.log('[ROUTE DEBUG]', JSON.stringify({originalPath: p, route: p.startsWith('/vot/') ? 'direct-vot' : p === '/video-translation/translate' ? 'media-translation' : 'other'}));
    if (req.method === 'POST' && p.endsWith('/video-translation/translate')) {
      console.log('[ROUTE DEBUG]', JSON.stringify({
        originalPath: p,
        route: p.startsWith('/vot/') ? 'direct-vot' : p === '/video-translation/translate' ? 'media-translation' : 'unknown'
      }));
    }
    if (p.startsWith('/vot/')) {
      if (!votGateway) { res.writeHead(404); return res.end(); }
      return votGateway(req, res);
    }
    if (p === '/video-translation/translate' && req.method === 'POST') {
      if (!votGateway) { res.writeHead(503); return res.end('VOT gateway disabled'); }
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1048576) throw Error('Translation request too large'); chunks.push(chunk); }
        const original = Buffer.concat(chunks);
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!['application/x-vot-envelope+protobuf', 'application/x-protobuf', 'application/octet-stream'].includes(contentType)) throw Error(`Unsupported media request Content-Type: ${contentType}`);
        // VOT's inherited request() can overwrite the envelope Content-Type.
        // The envelope parser below validates the wire structure regardless of header.
        const prepared = await prepareMediaTranslation(original, { publicBaseUrl: env.PUBLIC_BASE_URL });
        console.log('[MEDIA MODE] audio URL substituted in translation request');
        const { Readable } = await import('node:stream');
        const forwarded = Readable.from([prepared.body]);
        forwarded.method = req.method; forwarded.url = req.url;
        forwarded.headers = { ...req.headers, 'content-length': String(prepared.body.length) };
        return votGateway(forwarded, res);
      } catch (error) {
        console.error('[MEDIA MODE]', error.message);
        if (!res.headersSent) { res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Media translation preparation failed', detail: error.message })); }
        return;
      }
    }
    if (p === '/session/create' || p.startsWith('/video-translation/') || p.startsWith('/video-subtitles/') || p.startsWith('/stream-translation/')) {
      if (!votGateway) { res.writeHead(404); return res.end(); }
      return votGateway(req, res);
    }
    return handler(req, res);
  });
  server.requestTimeout = 30000;
  server.listen(Number(env.PORT || 3000), env.HOST || '127.0.0.1', () => console.log(`Universal Media Proxy listening on ${server.address().address}:${server.address().port}`));
  return server;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) startServer();
