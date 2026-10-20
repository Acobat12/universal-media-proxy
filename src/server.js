import { createVotGateway } from './vot-gateway.js';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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
function safeKey(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function createHandler({ secret, apiKey, publicBaseUrl, allowedHosts = DEFAULT_HOSTS, fetcher = fetch, mediaFetcher = pinnedFetch, ttlSeconds = 900, maxBytes = 1024 * 1024 * 1024, maxConcurrent = 4, dailyByteLimit = 2 * 1024 ** 3, fallbackEnabled = false, fallbackHosts = [], ytdlp, defaultMode = 'stream', parallelThreads = 8, parallelChunkBytes = 524288, cacheMaxBytes = 67108864, cacheMaxFileBytes = 33554432, cacheTtlMs = 600000, diskCacheDir, diskCacheTtlMs = 900000, diskCacheMaxBytes = 1073741824, diskCacheMaxFileBytes = 268435456 } = {}) {
  if (!secret || secret.length < 32) throw Error('TOKEN_SECRET must be at least 32 characters');
  if (!apiKey || apiKey.length < 16) throw Error('API_KEY must be at least 16 characters');
  if (!publicBaseUrl) throw Error('PUBLIC_BASE_URL required');
  const base = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw Error('Invalid PUBLIC_BASE_URL');
  const audioCache = createAudioCache({ maxBytes: cacheMaxBytes, ttlMs: cacheTtlMs });
  const diskCache = createDiskCache({ ...(diskCacheDir ? { directory: diskCacheDir } : {}), ttlMs: diskCacheTtlMs, maxBytes: diskCacheMaxBytes, maxFileBytes: diskCacheMaxFileBytes });
  const requests = new Map();
  let activeStreams = 0;
  let dailyBytes = 0;
  let day = new Date().toISOString().slice(0, 10);
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
        if (typeof req.headers['x-api-key'] !== 'string' || !safeKey(req.headers['x-api-key'], apiKey)) fail(401, 'Invalid API key');
        const ip = req.socket.remoteAddress || 'unknown';
        const now = Date.now(); const state = requests.get(ip) || { count: 0, reset: now + 60000 };
        if (now > state.reset) { state.count = 0; state.reset = now + 60000; }
        if (++state.count > 30) fail(429, 'Rate limit exceeded');
        requests.set(ip, state);
        if (requests.size > 10000) requests.clear();
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
      if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method)) {
        const token = url.pathname.slice('/media/'.length);
        const source = verify(token, secret);
        const today = new Date().toISOString().slice(0, 10);
        if (today !== day) { day = today; dailyBytes = 0; }
        if (activeStreams >= maxConcurrent) fail(429, 'Too many active streams');
        if (dailyBytes >= dailyByteLimit) fail(429, 'Daily transfer budget exhausted');
        activeStreams++;
        try {
          if (source.mode === 'parallel' || source.mode === 'cached' || source.mode === 'disk') {
            return await parallelAudio(req, res, source, { fetcher: mediaFetcher, allowedHosts, maxBytes, threads: parallelThreads, chunkBytes: parallelChunkBytes, cache: source.mode === 'cached' ? audioCache : null, diskCache: source.mode === 'disk' ? diskCache : null, cacheKey: `${source.videoUrl}|${source.quality}|${source.upstreams[0]}`, cacheMaxFileBytes, onBytes: n => { dailyBytes += n; if (dailyBytes > dailyByteLimit) res.destroy(Error('Daily transfer budget exceeded')); } });
          }
          return await proxyAudio(req, res, source, { fetcher: mediaFetcher, allowedHosts, maxBytes,
            refreshSource: () => refresh(source), onBytes: n => { dailyBytes += n; if (dailyBytes > dailyByteLimit) res.destroy(Error('Daily transfer budget exceeded')); }
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
  const handler = createHandler({ secret: env.TOKEN_SECRET, apiKey: env.API_KEY, publicBaseUrl: env.PUBLIC_BASE_URL, allowedHosts: (env.ALLOWED_UPSTREAM_HOSTS || DEFAULT_HOSTS.join(',')).split(',').map(s => s.trim()).filter(Boolean), maxBytes: Number(env.MAX_TRANSFER_BYTES || 1073741824), maxConcurrent: Number(env.MAX_CONCURRENT_STREAMS || 4), dailyByteLimit: Number(env.DAILY_TRANSFER_BYTES || 2147483648), fallbackEnabled: env.ENABLE_YTDLP === 'true', fallbackHosts: (env.YTDLP_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), defaultMode: env.DEFAULT_AUDIO_MODE || 'stream', parallelThreads: Number(env.PARALLEL_THREADS || 8), parallelChunkBytes: Number(env.PARALLEL_CHUNK_BYTES || 524288), cacheMaxBytes: Number(env.CACHE_MAX_BYTES || 67108864), cacheMaxFileBytes: Number(env.CACHE_MAX_FILE_BYTES || 33554432), cacheTtlMs: Number(env.CACHE_TTL_MS || 600000), diskCacheDir: env.DISK_CACHE_DIR, diskCacheTtlMs: Number(env.DISK_CACHE_TTL_MS || 900000), diskCacheMaxBytes: Number(env.DISK_CACHE_MAX_BYTES || 1073741824), diskCacheMaxFileBytes: Number(env.DISK_CACHE_MAX_FILE_BYTES || 268435456) });
  const votGateway = env.ENABLE_VOT_PROXY === 'true' ? createVotGateway({ yandexApiUrl: env.YANDEX_API_URL, serverId: env.SERVER_ID, maxBodyBytes: Number(env.VOT_MAX_BODY_BYTES || 1048576) }) : null;
  const server = http.createServer((req, res) => {
    if (req.url && new URL(req.url, 'http://localhost').pathname.startsWith('/vot/')) {
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
