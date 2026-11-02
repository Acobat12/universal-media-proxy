import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createAdapterMediaStorage } from '../core/universal-media-storage.js';
import { fail } from '../core/errors.js';
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';

const MEDIA = /^\/media\/anthropicskilljar\/([A-Za-z0-9]{8})\/audio\.m4a$/;
const registrations = new Map();
const jobs = new Map();
const TTL = 15 * 60 * 1000; // Signed JW Player manifests may expire sooner
const LIMIT = 1000;
const cache = createAdapterMediaStorage('anthropicskilljar', id => jobs.has(id));
const CACHE_DIR = cache.directory;
cache.sweep().catch(e => console.error('[Skilljar] Initial cache sweep failed:', e));
const MAX_CONCURRENT = 2;
const MAX_BUILD_MS = 20 * 60 * 1000;
const MAX_SEGMENTS = 3000;
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

function manifestFromId(id) {
  const item = registrations.get(id);
  if (!item || item.expires < Date.now()) fail(404, 'Skilljar video not registered');
  return item.url;
}
function parseManifest(value) {
  let u;
  try { u = new URL(value); } catch { fail(400, 'Invalid JW Player manifest URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'cdn.jwplayer.com' ||
      u.port || u.username || u.password || u.hash ||
      !/^\/manifests\/([A-Za-z0-9]{8})\.m3u8$/.test(u.pathname))
    fail(400, 'Untrusted JW Player manifest');
  return /^\/manifests\/([A-Za-z0-9]{8})\.m3u8$/.exec(u.pathname)[1];
}
function safeManifest(value) {
  const u = new URL(value);
  const allowed = new Set(['exp', 'sig']);
  for (const key of u.searchParams.keys())
    if (!allowed.has(key)) fail(400, 'Unexpected JW Player manifest parameter');
  if (u.search && (!/^\d{8,12}$/.test(u.searchParams.get('exp') || '') ||
      !/^[a-fA-F0-9]{16,128}$/.test(u.searchParams.get('sig') || '')))
    fail(400, 'Invalid JW Player signature parameters');
  return u.href;
}
function registered(id) {
  const item = registrations.get(id);
  if (!item || item.expires < Date.now()) {
    registrations.delete(id);
    fail(404, 'Skilljar video not registered; reopen the player');
  }
}
function filePath(id) { return join(CACHE_DIR, `${id}.m4a`); }
async function readyFile(id) {
  try {
    const s = await stat(filePath(id));
    return s.isFile() && s.size > 0 ? s : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
// Fetch only Skilljar-owned HLS resources; signed redirect URLs are validated too.
const HLS_HOSTS = new Set(['cdn.jwplayer.com', 'videos-cloudfront-usp.jwpsrv.com']);
function trustedHlsUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      u.hash || !HLS_HOSTS.has(u.hostname) ||
      !/^\/(?:manifests\/[A-Za-z0-9]{8}\.m3u8|[A-Za-z0-9_=/.,%-]+\.(?:m3u8|ts))$/.test(u.pathname))
    throw new Error('Untrusted Skilljar HLS resource');
  return u.href;
}
async function fetchHls(url, maxBytes, deadline) {
  let current = trustedHlsUrl(url);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1000, Math.min(45000, deadline - Date.now()))) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Skilljar HLS redirect without location');
      current = trustedHlsUrl(new URL(location, current).href);
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`Skilljar HLS HTTP ${response.status}`);
    const size = Number(response.headers.get('content-length'));
    if (size > maxBytes) throw new Error('Skilljar HLS resource too large');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('Skilljar HLS resource too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  throw new Error('Too many Skilljar HLS redirects');
}
function attrs(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))
    out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}
async function selectMediaPlaylist(url, deadline) {
  const lines = (await fetchHls(url, MAX_PLAYLIST_BYTES, deadline))
    .toString('utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Invalid HLS master');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attrs(lines[i].slice('#EXT-X-STREAM-INF:'.length));
    if (!/^mp4a\.40\.2$/.test(a.CODECS || '')) continue;
    const next = lines.slice(i + 1).find(s => !s.startsWith('#'));
    if (!next) break;
    const mediaUrl = trustedHlsUrl(new URL(next, url).href);
    const mediaLines = (await fetchHls(mediaUrl, MAX_PLAYLIST_BYTES, deadline))
      .toString('utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return { url: mediaUrl, lines: mediaLines };
  }
  throw new Error('Dedicated AAC-only rendition not found');
}
function parseSegments(lines, playlistUrl) {
  if (lines[0] !== '#EXTM3U' || !lines.includes('#EXT-X-ENDLIST') ||
      !lines.includes('#EXT-X-PLAYLIST-TYPE:VOD'))
    throw new Error('Not a complete HLS VOD playlist');
  const segments = [];
  for (const line of lines) {
    if (/^#EXT-X-(KEY|MAP|BYTERANGE|DISCONTINUITY|PART|PRELOAD-HINT)(?=:|$)/.test(line))
      throw new Error('Unsupported HLS feature');
    if (line.startsWith('#')) continue;
    const u = trustedHlsUrl(new URL(line, playlistUrl).href);
    if (!new URL(u).pathname.endsWith('.ts')) throw new Error('Expected MPEG-TS segment');
    segments.push(u);
    if (segments.length > MAX_SEGMENTS) throw new Error('Too many HLS segments');
  }
  if (!segments.length) throw new Error('Empty HLS playlist');
  return segments;
}
async function parallelHlsToTs(manifestUrl, output, deadline) {
  const playlist = await selectMediaPlaylist(manifestUrl, deadline);
  const segments = parseSegments(playlist.lines, playlist.url);
  // Sequential bounded spool avoids buffering all segments in RAM.
  const file = await open(output, 'wx', 0o600);
  try {
    for (const segment of segments) {
      const bytes = await fetchHls(segment, MAX_SEGMENT_BYTES, deadline);
      if (bytes.length < 188 || bytes[0] !== 0x47)
        throw new Error('Invalid MPEG-TS segment');
      await file.writeFile(bytes);
    }
  } finally { await file.close(); }
}
async function runFfmpeg(input, output, deadline) {
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-analyzeduration', '100000000', '-probesize', '100000000',
      '-i', input, '-map', '0:a:0', '-vn', '-c:a', 'copy',
      '-movflags', '+faststart', '-f', 'mp4', output
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, deadline - Date.now()));
    child.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-2000); });
    child.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.replace(/https?:\/\/[^\s'"\]]+/g, '[Skilljar URL redacted]')}`));
    });
  });
}

async function buildFile(id) {
  if (jobs.has(id)) return jobs.get(id);
  if (jobs.size >= MAX_CONCURRENT) fail(503, 'Skilljar conversion capacity reached; retry later');
    const job = Promise.resolve().then(async () => {
    const reservation = await cache.reserve(Math.min(Number(process.env.DISK_CACHE_MAX_BYTES || 1024 ** 3), 256 * 1024 ** 2));
    try {
    await mkdir(CACHE_DIR, { recursive: true });
    if (await readyFile(id)) return;
    const partial = join(CACHE_DIR, `${id}.${process.pid}.${Date.now()}.partial.m4a`);
    reservation.watch(partial);
    const tsPath = `${partial}.hls-input`;
    reservation.watch(tsPath);
    const deadline = Date.now() + MAX_BUILD_MS;
    try {
      await parallelHlsToTs(manifestFromId(id), tsPath, deadline);
      await runFfmpeg(tsPath, partial, deadline);
      const s = await stat(partial);
      if (!s.size) throw new Error('Empty M4A');
      await reservation.verify();
      await rename(partial, filePath(id));
      await unlink(tsPath).catch(() => {});
    } catch (e) {
      await unlink(tsPath).catch(() => {});
      await unlink(partial).catch(() => {});
      throw e;
    }
    } finally { reservation.release(); }
  });
  jobs.set(id, job);
  try { await job; } finally { jobs.delete(id); }
}

export const anthropicskilljar = {
  id: 'anthropicskilljar',
  mediaHosts: ['cdn.jwplayer.com', 'videos-cloudfront-usp.jwpsrv.com'],
  mediaTranslationPriority: 10,
  matches(u) {
    try { parseManifest(u.href); return true; } catch { return false; }
  },
  stableMediaPath(u) {
    return `/media/anthropicskilljar/${parseManifest(u.href)}/audio.m4a`;
  },
  async resolve(u) {
    const id = parseManifest(u.href);
    registered(id);
    return {
      site: 'anthropicskilljar', id, contentType: 'application/vnd.apple.mpegurl',
      upstreams: [manifestFromId(id)], headers: {}, metadata: { hls: true }
    };
  },
  async resolveMediaPath(path, context) {
    const m = MEDIA.exec(path);
    if (!m) fail(404, 'Invalid Skilljar media path');
    registered(m[1]);
    return this.resolve(new URL(manifestFromId(m[1])), context);
  },
  async handleRequest({ req, res, url, base, send }) {
    if (url.pathname === '/api/anthropicskilljar/register' && req.method === 'POST') {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2048) fail(413, 'Skilljar registration too large');
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'Invalid JSON'); }
      const id = parseManifest(data?.manifestUrl);
      if (typeof data?.pageUrl !== 'string') fail(400, 'Missing Skilljar page URL');
      let page;
      try { page = new URL(data.pageUrl); } catch { fail(400, 'Invalid Skilljar page URL'); }
      if (page.protocol !== 'https:' || page.hostname !== 'anthropic-partners.skilljar.com') fail(400, 'Wrong Skilljar page');
      if (data?.videoId !== id) fail(400, 'Skilljar video ID mismatch');
      for (const [key, expiry] of registrations) if (expiry.expires < Date.now()) registrations.delete(key);
      if (registrations.size >= LIMIT) registrations.delete(registrations.keys().next().value);
      registrations.set(id, { expires: Date.now() + TTL, url: safeManifest(data.manifestUrl) });
      send(200, { mediaUrl: new URL(`/media/anthropicskilljar/${id}/audio.m4a`, base).href });
      return true;
    }
    const match = MEDIA.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(req.method)) return false;
    const id = match[1];
    if (!(await readyFile(id))) registered(id);
    cache.retain(id);
    try {
      await buildFile(id);
      const s = await readyFile(id);
      if (!s) throw new Error('M4A cache file missing');
      const common = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
      const range = req.headers.range;
      let start = 0, end = s.size - 1, status = 200;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m || (!m[1] && !m[2])) {
          res.writeHead(416, { ...common, 'Content-Range': `bytes */${s.size}` }); res.end(); cache.release(id); return true;
        }
        if (!m[1]) {
          const suffix = Number(m[2]);
          if (!Number.isSafeInteger(suffix) || suffix <= 0) {
            res.writeHead(416, { ...common, 'Content-Range': `bytes */${s.size}` }); res.end(); cache.release(id); return true;
          }
          start = Math.max(0, s.size - suffix);
        } else {
          start = Number(m[1]);
          if (m[2]) end = Number(m[2]);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= s.size || start > end) {
          res.writeHead(416, { ...common, 'Content-Range': `bytes */${s.size}` }); res.end(); cache.release(id); return true;
        }
        end = Math.min(end, s.size - 1);
        status = 206;
      }
      const headers = { ...common, 'Content-Length': end - start + 1 };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${s.size}`;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') { res.end(); cache.release(id); return true; }
      const stream = createReadStream(filePath(id), { start, end });
      stream.on('error', e => { console.error('[Skilljar] file read:', e); res.destroy(e); });
      let released = false;
      const release = () => { if (!released) { released = true; cache.release(id); } };
      res.on('close', () => { stream.destroy(); release(); });
      stream.on('close', release);
      stream.pipe(res);
    } catch (e) {
      cache.release(id);
      console.error('[Skilljar] M4A preparation failed:', e);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Skilljar M4A preparation failed'); }
      else res.destroy(e);
    }
    return true;
  },
  async prepareMediaTranslation(body, { publicBaseUrl }) {
    let signed;
    try { signed = signedProxyMediaUrlFromEnvelope(body); }
    catch { return null; }
    if (!signed) return null;
    let candidate, base;
    try { candidate = new URL(signed); base = new URL(publicBaseUrl); }
    catch { return null; }
    const match = MEDIA.exec(candidate.pathname);
    if (candidate.origin !== base.origin || !match || candidate.search || candidate.hash ||
        candidate.username || candidate.password) return null;
    registered(match[1]);
    return { body, mediaUrl: candidate.href };
  }
};
export default anthropicskilljar;
