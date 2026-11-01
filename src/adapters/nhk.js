import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapterMediaStorage } from '../core/universal-media-storage.js';
import { createDecipheriv } from 'node:crypto';
import { fail } from '../core/errors.js';
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';

const MEDIA = /^\/media\/nhk\/([A-Za-z0-9_-]{8,100})\/audio\.m4a$/;
const registrations = new Map();
const jobs = new Map();
const TTL = 24 * 60 * 60 * 1000;
const LIMIT = 1000;
const cache = createAdapterMediaStorage('nhk', id => jobs.has(id));
const CACHE_DIR = cache.directory;
cache.sweep().catch(e => console.error('[NHK] Initial cache sweep failed:', e));
const MAX_CONCURRENT = 2;
const MAX_BUILD_MS = 20 * 60 * 1000;
const SEGMENT_WORKERS = Math.max(1, Math.min(64, Number(process.env.NHK_SEGMENT_WORKERS) || 32));
const MAX_SEGMENTS = 20000;
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

function manifestFromId(id) {
  return registrations.get(id)?.url || `https://masterpl.hls.nhkworld.jp/hls/w/${id}/master_nocc.m3u8`;
}
function parseManifest(value) {
  let u;
  try { u = new URL(value); } catch { fail(400, 'Invalid NHK manifest URL'); }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash)
    fail(400, 'Untrusted NHK manifest');
  const legacy = u.hostname === 'masterpl.hls.nhkworld.jp' && !u.search &&
    /^\/hls\/w\/([0-9]{12,24})\/master_nocc\.m3u8$/.exec(u.pathname);
  if (legacy) return legacy[1];
  if (u.hostname !== 'vod-stream.nhk.jp' ||
      !/^\/nhkworld\/upld\/medias\/news\/(?:video\/)?[a-zA-Z0-9_-]+\/index(?:_[a-zA-Z0-9_-]+)?\.m3u8$/.test(u.pathname))
    fail(400, 'Unsupported NHK manifest path');
  // Ignore session query parameters; never use arbitrary user-supplied upstreams.
  return /^\/nhkworld\/upld\/medias\/news\/(?:video\/)?([A-Za-z0-9_-]+)\//.exec(u.pathname)[1];
}
function safeManifest(value) {
  const u = new URL(value);
  return u.origin + u.pathname;
}
function registered(id) {
  const expiry = registrations.get(id);
  if (!expiry || expiry.expires < Date.now()) {
    registrations.delete(id);
    fail(404, 'NHK video not registered; reopen the player');
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
// Fetch only NHK-owned HLS resources; signed redirect URLs are validated too.
const HLS_HOSTS = new Set(['vod-stream.nhk.jp', 'masterpl.hls.nhkworld.jp', 'media-tyo.hls.nhkworld.jp']);
function trustedHlsUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !HLS_HOSTS.has(u.hostname))
    throw new Error('Untrusted NHK HLS resource');
  return u.href;
}
async function fetchHls(url, maxBytes, deadline) {
  let current = trustedHlsUrl(url);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1000, Math.min(45000, deadline - Date.now()))) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('NHK HLS redirect without location');
      current = trustedHlsUrl(new URL(location, current).href);
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`NHK HLS HTTP ${response.status}`);
    const size = Number(response.headers.get('content-length'));
    if (size > maxBytes) throw new Error('NHK HLS resource too large');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('NHK HLS resource too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  throw new Error('Too many NHK HLS redirects');
}
function attrs(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))
    out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}
async function selectMediaPlaylist(url, deadline) {
  for (let depth = 0; depth < 5; depth++) {
    const lines = (await fetchHls(url, MAX_PLAYLIST_BYTES, deadline)).toString('utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');
    if (!lines.some(x => x.startsWith('#EXT-X-STREAM-INF:'))) return { url, lines };
    // Prefer a dedicated audio rendition. NHK master playlists may expose
    // video-only variants whose BANDWIDTH is lower than the audio rendition.
    const audioRenditions = [];
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const a = attrs(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE !== 'AUDIO' || !a.URI) continue;
      audioRenditions.push({
        url: trustedHlsUrl(new URL(a.URI, url).href),
        default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        language: a.LANGUAGE || ''
      });
    }
    if (audioRenditions.length) {
      audioRenditions.sort((a, b) =>
        Number(b.default) - Number(a.default) ||
        Number(b.autoselect) - Number(a.autoselect) ||
        Number(b.language === 'en') - Number(a.language === 'en')
      );
      url = audioRenditions[0].url;
      continue;
    }
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = attrs(lines[i].slice('#EXT-X-STREAM-INF:'.length));
      const next = lines.slice(i + 1).find(x => !x.startsWith('#'));
      if (next) variants.push({ url: trustedHlsUrl(new URL(next, url).href), bandwidth: Number(a.BANDWIDTH) || 0 });
    }
    if (!variants.length) throw new Error('No HLS variants');
    variants.sort((a, b) => a.bandwidth - b.bandwidth);
    url = variants[0].url;
  }
  throw new Error('HLS playlist nesting too deep');
}
function parseSegments(lines, playlistUrl) {
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('Live/incomplete HLS playlist');
  let sequence = 0, key = null, init = null;
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.slice(22));
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrs(line.slice(11));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128' && a.URI && (!a.KEYFORMAT || a.KEYFORMAT === 'identity')) {
        key = { url: trustedHlsUrl(new URL(a.URI, playlistUrl).href), iv: a.IV || null };
      } else throw new Error('Unsupported HLS encryption');
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line.slice(11));
      if (!a.URI || a.BYTERANGE || key) throw new Error('Unsupported HLS initialization segment');
      const url = trustedHlsUrl(new URL(a.URI, playlistUrl).href);
      if (init && init.url !== url) throw new Error('Multiple HLS initialization segments');
      init = { url };
    } else if (/^#EXT-X-(BYTERANGE|DISCONTINUITY|PART|PRELOAD-HINT)(?=:|$)/.test(line)) {
      throw new Error('HLS feature requires FFmpeg fallback');
    } else if (!line.startsWith('#')) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid HLS media sequence');
      segments.push({ url: trustedHlsUrl(new URL(line, playlistUrl).href), sequence: sequence++, key: key && { ...key } });
      if (segments.length > MAX_SEGMENTS) throw new Error('Too many HLS segments');
    }
  }
  if (!segments.length) throw new Error('No HLS segments');
  return { segments, init };
}
async function parallelHlsToTs(manifestUrl, output, deadline) {
  const playlist = await selectMediaPlaylist(manifestUrl, deadline);
  const { segments, init } = parseSegments(playlist.lines, playlist.url);
  console.log('[NHK] Selected media playlist:', new URL(playlist.url).pathname.split('/').pop());
  if (init && segments.some(segment => segment.key))
    throw new Error('Encrypted fMP4 requires FFmpeg fallback');
  const keys = new Map();
  for (const segment of segments) {
    if (segment.key && !keys.has(segment.key.url)) {
      const bytes = await fetchHls(segment.key.url, 16, deadline);
      if (bytes.length !== 16) throw new Error('Invalid AES-128 key length');
      keys.set(segment.key.url, bytes);
    }
  }
  const parts = new Array(segments.length);
  const initBytes = init ? await fetchHls(init.url, MAX_SEGMENT_BYTES, deadline) : null;
  let next = 0;
  const workers = Math.min(SEGMENT_WORKERS, segments.length);
  console.log('[NHK] Parallel HLS:', { segments: segments.length, workers, format: init ? 'fMP4' : 'TS', encrypted: keys.size > 0 });
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < segments.length) {
      const i = next++;
      const segment = segments[i];
      let bytes = await fetchHls(segment.url, MAX_SEGMENT_BYTES, deadline);
      if (segment.key) {
        const iv = segment.key.iv
          ? Buffer.from(segment.key.iv.replace(/^0x/i, ''), 'hex')
          : (() => { const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(segment.sequence), 8); return b; })();
        if (iv.length !== 16) throw new Error('Invalid AES-128 IV');
        const decipher = createDecipheriv('aes-128-cbc', keys.get(segment.key.url), iv);
        bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
      }
      parts[i] = bytes;
    }
  }));
  const file = await open(output, 'w');
  try {
    if (initBytes) await file.writeFile(initBytes);
    for (const part of parts) await file.writeFile(part);
  }
  finally { await file.close(); }
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
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.replace(/https?:\/\/[^\s'"\]]+/g, '[NHK URL redacted]')}`));
    });
  });
}

async function buildFile(id) {
  if (await readyFile(id)) return;
  if (jobs.has(id)) return jobs.get(id);
  if (jobs.size >= MAX_CONCURRENT) fail(503, 'NHK conversion capacity reached; retry later');
    const job = (async () => {
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
      let input = manifestFromId(id);
      try {
        await parallelHlsToTs(input, tsPath, deadline);
        input = tsPath;
      } catch (e) {
        await unlink(tsPath).catch(() => {});
        console.warn('[NHK] Parallel HLS unavailable, using FFmpeg:', String(e.message).replace(/https?:\/\/[^\s]+/g, '[URL redacted]'));
      }
      await runFfmpeg(input, partial, deadline);
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
  })();
  jobs.set(id, job);
  try { await job; } finally { jobs.delete(id); }
}

export const nhk = {
  id: 'nhk',
  mediaHosts: ['masterpl.hls.nhkworld.jp', 'media-tyo.hls.nhkworld.jp', 'vod-stream.nhk.jp'],
  mediaTranslationPriority: 10,
  matches(u) {
    try { parseManifest(u.href); return true; } catch { return false; }
  },
  stableMediaPath(u) {
    return `/media/nhk/${parseManifest(u.href)}/audio.m4a`;
  },
  async resolve(u) {
    const id = parseManifest(u.href);
    registered(id);
    return {
      site: 'nhk', id, contentType: 'application/vnd.apple.mpegurl',
      upstreams: [manifestFromId(id)], headers: {}, metadata: { hls: true }
    };
  },
  async resolveMediaPath(path, context) {
    const m = MEDIA.exec(path);
    if (!m) fail(404, 'Invalid NHK media path');
    registered(m[1]);
    return this.resolve(new URL(manifestFromId(m[1])), context);
  },
  async handleRequest({ req, res, url, base, send }) {
    if (url.pathname === '/api/nhk/register' && req.method === 'POST') {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2048) fail(413, 'NHK registration too large');
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'Invalid JSON'); }
      const id = parseManifest(data?.manifestUrl);
      if (data?.videoId !== id) fail(400, 'NHK video ID mismatch');
      for (const [key, expiry] of registrations) if (expiry.expires < Date.now()) registrations.delete(key);
      if (registrations.size >= LIMIT) registrations.delete(registrations.keys().next().value);
      registrations.set(id, { expires: Date.now() + TTL, url: safeManifest(data.manifestUrl) });
      send(200, { mediaUrl: new URL(`/media/nhk/${id}/audio.m4a`, base).href });
      return true;
    }
    const match = MEDIA.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(req.method)) return false;
    const id = match[1];
    registered(id);
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
      stream.on('error', e => { console.error('[NHK] file read:', e); res.destroy(e); });
      let released = false;
      const release = () => { if (!released) { released = true; cache.release(id); } };
      res.on('close', () => { stream.destroy(); release(); });
      stream.on('close', release);
      stream.pipe(res);
    } catch (e) {
      cache.release(id);
      console.error('[NHK] M4A preparation failed:', e);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('NHK M4A preparation failed'); }
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
export default nhk;
