import { createVotGateway } from './vot-gateway.js';
import { prepareMediaTranslation } from './media-translation.js';
import http from 'node:http';
import { Registry } from './core/registry.js';
import { bilibili } from './adapters/bilibili.js';
import { sign, verify } from './core/token.js';
import { proxyAudio } from './core/proxy.js';
import { parallelAudio, createAudioCache } from './core/parallel.js';
import { createDiskCache } from './core/disk-cache.js';
import { pinnedFetch } from './core/transport.js';
import { HttpError, fail } from './core/errors.js';
import { assertPublicUrl } from './core/security.js';
import { extractAudio } from './core/extraction.js';

const registry = new Registry().register(bilibili);
const DEFAULT_HOSTS = ['bilivideo.com', 'bilibili.com', 'hdslb.com'];
export function createHandler({ secret, publicBaseUrl, allowedHosts = DEFAULT_HOSTS, fetcher = fetch, mediaFetcher = pinnedFetch, ttlSeconds = 900, maxBytes = 1024 * 1024 * 1024, maxConcurrent = 4, fallbackEnabled = false, fallbackHosts = [], ytdlp, defaultMode = 'stream', parallelThreads = 8, parallelChunkBytes = 524288, cacheMaxBytes = 67108864, cacheMaxFileBytes = 33554432, cacheTtlMs = 600000, diskCacheDir, diskCacheTtlMs = 900000, diskCacheMaxBytes = 1073741824, diskCacheMaxFileBytes = 268435456 } = {}) {
  if (!secret || secret.length < 32) throw Error('TOKEN_SECRET must be at least 32 characters');
  if (!publicBaseUrl) throw Error('PUBLIC_BASE_URL required');
  const base = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw Error('Invalid PUBLIC_BASE_URL');
  const audioCache = createAudioCache({ maxBytes: cacheMaxBytes, ttlMs: cacheTtlMs });
  const diskCache = createDiskCache({ ...(diskCacheDir ? { directory: diskCacheDir } : {}), ttlMs: diskCacheTtlMs, maxBytes: diskCacheMaxBytes, maxFileBytes: diskCacheMaxFileBytes });
  let activeStreams = 0;
  const stableResolveJobs = new Map();
  const refreshCache = new Map();
  const refresh = async (payload) => {
    if (!payload.videoUrl) return null;
    const key = `${payload.videoUrl}|${payload.quality}`;
    const existing = refreshCache.get(key);
    if (existing && existing.until > Date.now()) return existing.value;
    const value = await extractAudio(new URL(payload.videoUrl), { registry, fetcher, quality: payload.quality, signal: AbortSignal.timeout(20000), fallbackEnabled, fallbackHosts, ytdlp });
    for (const candidate of value.upstreams) await assertPublicUrl(candidate, allowedHosts);
    refreshCache.set(key, { value, until: Date.now() + 30000 });
    if (refreshCache.size > 500) refreshCache.clear();
    return value;
  };
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
        const quality = body.quality || 'best';
        const mode = body.mode || defaultMode;
        if (!['stream', 'parallel', 'cached', 'disk'].includes(mode)) fail(400, 'Invalid mode');
        const source = await extractAudio(target, { registry, fetcher, quality, signal: AbortSignal.timeout(20000), fallbackEnabled, fallbackHosts, ytdlp });
        // Never issue a token for an upstream not on the approved DNS allowlist.
        for (const candidate of source.upstreams) await assertPublicUrl(candidate, allowedHosts);
        const exp = Date.now() + ttlSeconds * 1000;
        const token = sign({ site: source.site, videoUrl: target.href, quality, upstreams: source.upstreams, headers: source.headers, contentType: source.contentType, mode, exp }, secret);
        return send(200, { site: source.site, id: source.id, metadata: source.metadata, mode, expiresAt: new Date(exp).toISOString(), mediaUrl: new URL(`/media/${token}`, base).href });
      }
      const stable = /^\/media\/bilibili\/(BV[A-Za-z0-9]+)\/p([1-9]\d*)\/audio\.m4a$/.exec(url.pathname);
      if (stable && ['GET', 'HEAD'].includes(req.method)) {
        const page = Number(stable[2]);
        if (!Number.isSafeInteger(page) || page > 1000) fail(400, 'Invalid Bilibili part');
        const videoUrl = `https://www.bilibili.com/video/${stable[1]}/?p=${page}`;
        const key = `${stable[1]}:p${page}`;
        // Only the first media request resolves the Bilibili source; concurrent
        // requests share the same resolution promise, not duplicate API calls.
        let job = stableResolveJobs.get(key);
        if (!job) {
          job = extractAudio(new URL(videoUrl), { registry, fetcher, quality: 'best', signal: AbortSignal.timeout(20000), fallbackEnabled, fallbackHosts, ytdlp })
            .then(async source => {
              for (const candidate of source.upstreams) await assertPublicUrl(candidate, allowedHosts);
              return { ...source, videoUrl, quality: 'best', mode: 'disk' };
            });
          stableResolveJobs.set(key, job);
          job.finally(() => { if (stableResolveJobs.get(key) === job) stableResolveJobs.delete(key); }).catch(() => {});
        }
        const source = await job;
        activeStreams++;
        try {
          // Stream the upstream response immediately; do not wait for a full download.
          return await proxyAudio(req, res, source, { fetcher: mediaFetcher, allowedHosts, maxBytes,
            refreshSource: () => refresh(source), onBytes: () => {} });
        } finally { activeStreams--; }
      }
      if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method)) {
        const token = url.pathname.slice('/media/'.length);
        const source = verify(token, secret);
        activeStreams++;
        try {
          if (source.mode === 'parallel' || source.mode === 'cached' || source.mode === 'disk') {
            return await parallelAudio(req, res, source, { fetcher: mediaFetcher, allowedHosts, maxBytes, threads: parallelThreads, chunkBytes: parallelChunkBytes, cache: source.mode === 'cached' ? audioCache : null, diskCache: source.mode === 'disk' ? diskCache : null, cacheKey: `${source.videoUrl}|${source.quality}|${source.upstreams[0]}`, cacheMaxFileBytes, onBytes: () => {} });
          }
          return await proxyAudio(req, res, source, { fetcher: mediaFetcher, allowedHosts, maxBytes,
            refreshSource: () => refresh(source), onBytes: () => {}
          });
        } finally { activeStreams--; }
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
  const handler = createHandler({ secret: env.TOKEN_SECRET, publicBaseUrl: env.PUBLIC_BASE_URL, allowedHosts: (env.ALLOWED_UPSTREAM_HOSTS || DEFAULT_HOSTS.join(',')).split(',').map(s => s.trim()).filter(Boolean), maxBytes: Number(env.MAX_TRANSFER_BYTES || 1073741824), maxConcurrent: Number(env.MAX_CONCURRENT_STREAMS || 4), fallbackEnabled: env.ENABLE_YTDLP === 'true', fallbackHosts: (env.YTDLP_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), defaultMode: env.DEFAULT_AUDIO_MODE || 'stream', parallelThreads: Number(env.PARALLEL_THREADS || 8), parallelChunkBytes: Number(env.PARALLEL_CHUNK_BYTES || 524288), cacheMaxBytes: Number(env.CACHE_MAX_BYTES || 67108864), cacheMaxFileBytes: Number(env.CACHE_MAX_FILE_BYTES || 33554432), cacheTtlMs: Number(env.CACHE_TTL_MS || 600000), diskCacheDir: env.DISK_CACHE_DIR, diskCacheTtlMs: Number(env.DISK_CACHE_TTL_MS || 900000), diskCacheMaxBytes: Number(env.DISK_CACHE_MAX_BYTES || 1073741824), diskCacheMaxFileBytes: Number(env.DISK_CACHE_MAX_FILE_BYTES || 268435456) });
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
