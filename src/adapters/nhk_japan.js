import { spawn } from 'node:child_process';
import { createHash, createDecipheriv } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterMediaCache } from '../core/adapter-media-cache.js';
import { fail } from '../core/errors.js';
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';

const MEDIA = /^\/media\/nhk-japan\/([A-Z]\d{10}_\d{5}|[0-9]{8}[a-z0-9]+_[A-Za-z0-9_]+)\/audio\.m4a$/;
const registrations = new Map();
const jobs = new Map();
const TTL = 60 * 60 * 1000;
const LIMIT = 1000;
const cache = adapterMediaCache('nhk-japan', id => jobs.has(id));
const CACHE_DIR = cache.directory;
cache.sweep().catch(e => console.error('[NHK_JAPAN] Initial cache sweep failed:', e));
const MAX_CONCURRENT = 2;
const MAX_BUILD_MS = 20 * 60 * 1000;
const SEGMENT_WORKERS = Math.max(1, Math.min(64, Number(process.env.NHK_JAPAN_SEGMENT_WORKERS) || 32));
const MAX_SEGMENTS = 4000;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

function safeCdnUrl(raw, parent) {
  const u = new URL(raw, parent);
  if (u.protocol !== 'https:' || u.hostname !== 'media.vd.st.nhk' || u.port ||
      u.username || u.password || u.hash || u.href.length > 4096 ||
      !/^\/(?:das|news\/nd)\//.test(u.pathname)) throw new Error('Untrusted NHK HLS resource');
  return u.href;
}
async function fetchCdn(raw, parent, maxBytes = MAX_SEGMENT_BYTES) {
  let url = safeCdnUrl(raw, parent);
  for (let redirect = 0; redirect < 4; redirect++) {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const next = r.headers.get('location');
      if (!next) throw new Error('NHK redirect without Location');
      url = safeCdnUrl(next, url);
      await r.body?.cancel();
      continue;
    }
    if (!r.ok) { await r.body?.cancel(); throw new Error(`NHK HLS HTTP ${r.status}`); }
    const length = Number(r.headers.get('content-length'));
    if (length > maxBytes) { await r.body?.cancel(); throw new Error('NHK resource too large'); }
    const chunks = []; let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > maxBytes) { await r.body.cancel().catch(() => {}); throw new Error('NHK resource too large'); }
      chunks.push(chunk);
    }
    return { url, data: Buffer.concat(chunks) };
  }
  throw new Error('Too many NHK redirects');
}
function parseAttrs(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}
function parseMediaPlaylist(text, base) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist');
  if (lines.some(x => /^#EXT-X-(MAP|BYTERANGE|PART|DISCONTINUITY|I-FRAMES-ONLY)/.test(x)))
    throw new Error('Unsupported HLS playlist layout');
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('Live HLS is not supported by segment downloader');
  let seq = 0, key = null, pending = false;
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice('#EXT-X-KEY:'.length));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128' && a.URI) key = { url: safeCdnUrl(a.URI, base), iv: a.IV || null };
      else throw new Error('Unsupported HLS encryption');
    } else if (line.startsWith('#EXTINF:')) pending = true;
    else if (!line.startsWith('#')) {
      if (!pending) throw new Error('Unexpected HLS segment');
      segments.push({ url: safeCdnUrl(line, base), seq: seq++, key });
      pending = false;
    }
  }
  if (!segments.length || segments.length > MAX_SEGMENTS || !Number.isSafeInteger(seq))
    throw new Error('Invalid NHK segment count');
  return segments;
}
async function loadSegments(master, dir) {
  const top = await fetchCdn(master, undefined, 2 * 1024 * 1024);
  let playlist = top;
  const text = top.data.toString('utf8');
  if (text.includes('#EXT-X-STREAM-INF:')) {
    const lines = text.split(/\r?\n/).map(x => x.trim());
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = parseAttrs(lines[i].slice('#EXT-X-STREAM-INF:'.length));
      const uri = lines.slice(i + 1).find(x => x && !x.startsWith('#'));
      if (uri) variants.push({ uri, bandwidth: Number(attrs.BANDWIDTH) || Infinity });
    }
    if (!variants.length) throw new Error('No NHK HLS variants');
    variants.sort((a, b) => a.bandwidth - b.bandwidth);
    playlist = await fetchCdn(variants[0].uri, top.url, 2 * 1024 * 1024);
  }
  const segments = parseMediaPlaylist(playlist.data.toString('utf8'), playlist.url);
  console.log('[NHK-Japan] Parallel HLS:', { segments: segments.length, workers: SEGMENT_WORKERS,
    encrypted: segments.some(x => x.key), playlistType: playlist.url === top.url ? 'media' : 'master' });
  const keyCache = new Map();
  async function keyBytes(url) {
    if (!keyCache.has(url)) keyCache.set(url, fetchCdn(url, undefined, 1024).then(x => {
      if (x.data.length !== 16) throw new Error('Invalid AES-128 key length');
      return x.data;
    }));
    return keyCache.get(url);
  }
  let next = 0;
  const paths = Array(segments.length);
  async function worker() {
    while (next < segments.length) {
      const index = next++;
      const seg = segments[index];
      let data = (await fetchCdn(seg.url)).data;
      if (seg.key) {
        const iv = seg.key.iv ? Buffer.from(seg.key.iv.replace(/^0x/i, ''), 'hex') : Buffer.alloc(16);
        if (!seg.key.iv) iv.writeBigUInt64BE(BigInt(seg.seq), 8);
        if (iv.length !== 16) throw new Error('Invalid HLS IV');
        const decipher = createDecipheriv('aes-128-cbc', await keyBytes(seg.key.url), iv);
        data = Buffer.concat([decipher.update(data), decipher.final()]);
      }
      const path = join(dir, `${String(index).padStart(5, '0')}.ts`);
      await writeFile(path, data);
      paths[index] = path;
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEGMENT_WORKERS, segments.length) }, worker));
  const joined = join(dir, 'joined.ts');
  await writeFile(joined, Buffer.alloc(0));
  for (const path of paths) await appendFile(joined, await readFile(path));
  return joined;
}


function parseManifest(value) {
  let u;
  try { u = new URL(value); } catch { fail(400, 'Invalid NHK Japan manifest URL'); }
  // Both news.web.nhk (/news/nd/) and edu.web.nhk (/das/) use this CDN.
  // Restrict the upstream to known NHK HLS paths, including optional CDN tokens.
  const parts = u.pathname.split('/').filter(Boolean);
  const token = part => /^hdntl=[A-Za-z0-9%~+._*=-]{1,600}$/.test(part);
  const filename = part => /^index(?:_[A-Za-z0-9_-]+)?\.m3u8$/i.test(part);
  const news = parts.length >= 4 && parts[0] === 'news' && parts[1] === 'nd' &&
    /^[A-Za-z0-9_-]+$/.test(parts[2]) &&
    (parts.length === 4 && filename(parts[3]) ||
     parts.length === 5 && token(parts[3]) && filename(parts[4]));
  const das = parts.length >= 4 && parts[0] === 'das' &&
    /^[A-Za-z0-9_-]+$/.test(parts[1]) && /^[A-Za-z0-9_-]+$/.test(parts[2]) &&
    (parts.length === 4 && filename(parts[3]) ||
     parts.length === 5 && token(parts[3]) && filename(parts[4]));
  const allowedQuery = new Set(['hdnts', 'aka_me_session_id', 'aka_media_format_type']);
  const queryValid = [...u.searchParams].every(([key, value]) =>
    allowedQuery.has(key) && value.length > 0 && value.length <= 700 &&
    (key !== 'aka_media_format_type' || value === 'hls'));
  if (u.protocol !== 'https:' || u.hostname !== 'media.vd.st.nhk' || u.port ||
      u.username || u.password || u.hash || u.href.length > 4096 ||
      !(news || das) || !queryValid) {
    fail(400, 'Untrusted NHK Japan manifest');
  }
  return u.href;
}

function manifestId(url) {
  const pathname = new URL(url).pathname;
  // Education: stable episode ID, independent of expiring CDN signatures.
  const episode = /^\/das\/[^/]+\/([A-Z]\d{10}_\d{5})_V_\d+\//.exec(pathname);
  if (episode) return episode[1];
  // News: stable CDN media identifier, independent of expiring tokens.
  const news = /^\/news\/nd\/([A-Za-z0-9_-]+)\//.exec(pathname);
  if (news) return news[1];
  fail(400, 'Unsupported NHK media identifier');
}
function manifestFromId(id) {
  registered(id);
  return registrations.get(id).url;
}
function registered(id) {
  const entry = registrations.get(id);
  if (!entry || entry.expiry < Date.now()) {
    registrations.delete(id);
    fail(404, 'NHK Japan video not registered or token expired; reopen player');
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
async function buildFile(id) {
  if (await readyFile(id)) return;
  if (jobs.has(id)) return jobs.get(id);
  if (jobs.size >= MAX_CONCURRENT) fail(503, 'NHK conversion capacity reached; retry later');
  const job = (async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    if (await readyFile(id)) return;
    const partial = join(CACHE_DIR, `${id}.${process.pid}.${Date.now()}.partial.m4a`);
    try {
      const workDir = join(CACHE_DIR, `${id}.${process.pid}.${Date.now()}.segments`);
      let input = manifestFromId(id);
      try {
        await mkdir(workDir, { recursive: true });
        input = await loadSegments(input, workDir);
        await new Promise((resolve, reject) => {
          const child = spawn('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y',
            '-analyzeduration', '100000000', '-probesize', '100000000',
            '-f', 'mpegts', '-i', input,
            '-map', '0:a:0', '-vn', '-c:a', 'copy',
            '-movflags', '+faststart', '-f', 'mp4', partial
          ], { stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '', settled = false;
          const timer = setTimeout(() => child.kill('SIGKILL'), MAX_BUILD_MS);
          child.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-4000); });
          child.on('error', e => { if (!settled) { settled = true; reject(e); } });
          child.on('close', code => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited ${code}: ${stderr.replace(/https:\/\/[^\s'"]+/g, '[NHK signed URL redacted]')}`));
          });
        });
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
      const s = await stat(partial);
      if (!s.size) throw new Error('Empty M4A');
      await rename(partial, filePath(id));
    } catch (e) {
      await unlink(partial).catch(() => {});
      throw e;
    }
  })();
  jobs.set(id, job);
  try { await job; } finally { jobs.delete(id); }
}

export const nhkJapan = {
  id: 'nhk-japan',
  mediaHosts: ['media.vd.st.nhk'],
  mediaTranslationPriority: 10,
  matches(u) {
    try { parseManifest(u.href); return true; } catch { return false; }
  },
  stableMediaPath(u) {
    const url = parseManifest(u.href);
    const id = manifestId(url);
    registered(id);
    return `/media/nhk-japan/${id}/audio.m4a`;
  },
  async resolve(u) {
    const url = parseManifest(u.href);
    const id = manifestId(url);
    registered(id);
    return {
      site: 'nhk-japan', id, contentType: 'application/vnd.apple.mpegurl',
      upstreams: [url], headers: {}, metadata: { hls: true }
    };
  },
  async resolveMediaPath(path, context) {
    const m = MEDIA.exec(path);
    if (!m) fail(404, 'Invalid NHK media path');
    registered(m[1]);
    return this.resolve(new URL(manifestFromId(m[1])), context);
  },
  async handleRequest({ req, res, url, base, send }) {
    if (url.pathname === '/api/nhk-japan/register' && req.method === 'POST') {
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
      const manifest = parseManifest(data?.manifestUrl);
      const kind = new URL(manifest);
      console.log('[NHK-Japan] Registered manifest:', {
        type: kind.pathname.includes('/hdntl=') ? 'nested' : 'master',
        hasHdnts: kind.searchParams.has('hdnts')
      });
      const id = manifestId(manifest);
      if (data?.videoId !== id) fail(400, 'NHK Japan video ID mismatch');
      for (const [key, entry] of registrations) if (entry.expiry < Date.now()) registrations.delete(key);
      if (registrations.size >= LIMIT) registrations.delete(registrations.keys().next().value);
      registrations.set(id, { url: manifest, expiry: Date.now() + TTL });
      send(200, { mediaUrl: new URL(`/media/nhk-japan/${id}/audio.m4a`, base).href });
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
      stream.on('error', e => { console.error('[NHK-Japan] file read:', e); res.destroy(e); });
      let released = false;
      const release = () => { if (!released) { released = true; cache.release(id); } };
      res.on('close', () => { stream.destroy(); release(); });
      stream.on('close', release);
      stream.pipe(res);
    } catch (e) {
      cache.release(id);
      console.error('[NHK-Japan] M4A preparation failed:', e);
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
export default nhkJapan;
