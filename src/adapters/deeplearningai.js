import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createAdapterMediaStorage } from '../core/universal-media-storage.js';
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';
import { fail } from '../core/errors.js';

const SITE = 'learn.deeplearning.ai';
const CDN = 'video.deeplearning.ai';
const MEDIA = /^\/media\/deeplearningai\/(\d{8,}-[a-f0-9]+)\/audio\.m4a$/i;
const registrations = new Map();
const jobs = new Map();
const MAX_CONCURRENT = 2;
const SEGMENT_WORKERS = Math.max(1, Math.min(64, Number(process.env.DEEPLEARNINGAI_SEGMENT_WORKERS) || 32));
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const MAX_SEGMENTS = 2000;
const MAX_BUILD_MS = 20 * 60 * 1000;
const TTL = 24 * 60 * 60_000;
const MAX_FILE = Math.min(256 * 1048576, Number(process.env.DISK_CACHE_MAX_FILE_BYTES || 256 * 1048576));
const cache = createAdapterMediaStorage('deeplearningai', id => jobs.has(id));
const DIR = cache.directory;
cache.sweep().catch(e => console.error('[deeplearningai] sweep:', e));

function lessonUrl(value) {
  let u; try { u = new URL(value); } catch { fail(400, 'Invalid lesson URL'); }
  if (u.protocol !== 'https:' || u.hostname !== SITE || u.port || u.username || u.password ||
      !/^\/courses\/[a-zA-Z0-9_/-]{5,512}$/.test(u.pathname) || u.pathname.includes('..')) fail(400, 'Invalid lesson URL');
  return u.origin + u.pathname;
}
function mediaUrl(value) {
  let u; try { u = new URL(value); } catch { fail(400, 'Invalid media URL'); }
  if (u.protocol !== 'https:' || u.hostname !== CDN || u.port || u.username || u.password || u.hash ||
      !/^\/upv2\/[A-Za-z0-9_.%/-]+\.(?:mp4|m3u8|ts)$/.test(u.pathname) || u.pathname.includes('..') || /%2f|%5c|%2e/i.test(u.pathname)) fail(400, 'Untrusted DeepLearning.AI media URL');
  return u.href;
}
function canonicalVideoId(source) {
  const path = new URL(source).pathname;
  const match = /^\/upv2\/([a-zA-Z0-9_-]+)\/[^/]+\/(\d{8,}-[a-f0-9]+)(?:-master)?\.m3u8$/i.exec(path)
    || /^\/upv2\/([a-zA-Z0-9_-]+)\/[^/]+\/\d{8,}\/video\/\d+\/(\d{8,}-[a-f0-9]+)\.m3u8$/i.exec(path);
  if (!match) fail(400, 'Media asset identity unavailable');
  return `${match[1]}/${match[2]}`;
}
const lessonIds = new Map();
function registeredLessonId(lesson) {
  const id = lessonIds.get(lesson);
  if (!id) fail(404, 'Register the lesson with a canonical video ID first');
  return id;
}

function get(id) {
  const v = registrations.get(id);
  if (!v || v.until <= Date.now()) { registrations.delete(id); fail(404, 'Registration expired: reopen lesson'); }
  return v;
}
function output(id) { return join(DIR, `${id}.m4a`); }
async function ready(id) {
  try { const s = await stat(output(id)); return s.isFile() && s.size > 0 ? s : null; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function download(url, dest, limit, signal) {
  // Never follow redirects to an untrusted destination.
  let current = mediaUrl(url);
  for (let i = 0; i < 4; i++) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) fail(502, 'CDN redirect missing location');
      current = mediaUrl(new URL(next, current).href);
      continue;
    }
    if (!response.ok || !response.body) fail(502, `DeepLearning.AI CDN HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > limit) fail(413, 'Source video too large');
    let total = 0;
    const source = async function* () {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > limit) fail(413, 'Source video too large');
        yield chunk;
      }
    };
    await pipeline(source(), createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
    return;
  }
  fail(502, 'Too many CDN redirects');
}
// HLS is downloaded as validated local MPEG-TS, never fetched by FFmpeg itself.
// This prevents playlists from redirecting FFmpeg to arbitrary hosts or protocols.
async function playlistText(url, signal) {
  let current = mediaUrl(url);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) fail(502, 'HLS redirect without location');
      current = mediaUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok || !response.body) fail(502, `HLS playlist HTTP ${response.status}`);
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) fail(413, 'HLS playlist too large');
      chunks.push(chunk);
    }
    return { url: current, text: Buffer.concat(chunks).toString('utf8') };
  }
  fail(502, 'Too many HLS redirects');
}
async function hlsSegments(url, signal) {
  let item = await playlistText(url, signal);
  for (let depth = 0; depth < 2; depth++) {
    const lines = item.text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') fail(422, 'Invalid HLS playlist');
    if (lines.some(x => /^#EXT-X-(KEY|SESSION-KEY|MAP|BYTERANGE):/.test(x))) fail(422, 'Unsupported encrypted/fMP4/byte-range HLS');
    if (lines.some(x => x.startsWith('#EXT-X-STREAM-INF:'))) {
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const next = lines.slice(i + 1).find(x => !x.startsWith('#'));
        if (next) variants.push(next);
      }
      if (!variants.length) fail(422, 'HLS master has no variants');
      const selected = variants.find(x => /\/video\/360\//.test(x)) || variants[variants.length - 1];
      const nextUrl = mediaUrl(new URL(selected, item.url).href);
      if (!nextUrl.endsWith('.m3u8')) fail(422, 'Invalid HLS variant');
      item = await playlistText(nextUrl, signal);
      continue;
    }
    if (!lines.some(x => x.startsWith('#EXTINF:')) || !lines.includes('#EXT-X-ENDLIST')) fail(422, 'Expected HLS VOD segment playlist');
    const segments = lines.filter(x => !x.startsWith('#'));
    if (!segments.length || segments.length > MAX_SEGMENTS) fail(422, 'Invalid HLS segment count');
    return segments.map(x => {
      const target = mediaUrl(new URL(x, item.url).href);
      if (new URL(target).pathname.toLowerCase().endsWith('.ts') === false) fail(422, 'Only MPEG-TS HLS segments supported');
      return target;
    });
  }
  fail(422, 'Nested HLS master unsupported');
}
// Bounded parallel downloads spool to disk, not an unbounded Buffer[] in RAM.
// Segment names are contained in a managed .segments directory for crash cleanup.
async function fetchSegment(url, dest, signal, deadline) {
  let current = mediaUrl(url);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (signal.aborted || deadline <= Date.now()) throw signal.reason || Error('HLS build timeout');
    const timeout = Math.max(1, Math.min(30000, deadline - Date.now()));
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) fail(502, 'Segment redirect without location');
      current = mediaUrl(new URL(location, current).href);
      if (!new URL(current).pathname.endsWith('.ts')) fail(422, 'Invalid segment redirect');
      continue;
    }
    if (!response.ok || !response.body) fail(502, `HLS segment HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_SEGMENT_BYTES) fail(413, 'HLS segment too large');
    let total = 0;
    await pipeline((async function* () {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_SEGMENT_BYTES) fail(413, 'HLS segment too large');
        yield chunk;
      }
    })(), createWriteStream(dest, { flags: 'wx', mode: 0o600 }), { signal });
    return total;
  }
  fail(502, 'Too many HLS segment redirects');
}
async function downloadHls(url, dest, spool, limit, signal, deadline) {
  const segments = await hlsSegments(url, signal);
  await mkdir(spool, { recursive: false, mode: 0o700 });
  const workers = Math.min(SEGMENT_WORKERS, segments.length);
  let next = 0, total = 0;
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  console.log('[deeplearningai] Parallel HLS:', { segments: segments.length, workers, format: 'TS', storage: 'disk' });
  try {
    await Promise.all(Array.from({ length: workers }, async () => {
      while (next < segments.length && !combined.aborted) {
        const i = next++;
        try {
          const bytes = await fetchSegment(segments[i], join(spool, `${i}.ts`), combined, deadline);
          total += bytes;
          if (total > limit) fail(413, 'HLS source too large');
        } catch (error) { controller.abort(error); throw error; }
      }
    }));
    if (combined.aborted) throw combined.reason;
    const out = await open(dest, 'wx', 0o600);
    try {
      for (let i = 0; i < segments.length; i++) {
        if (combined.aborted || Date.now() >= deadline) throw Error('HLS assembly cancelled or timed out');
        const source = createReadStream(join(spool, `${i}.ts`));
        for await (const chunk of source) await out.writeFile(chunk);
      }
    } finally { await out.close(); }
  } finally { controller.abort(); }
}
async function convert(input, dest, signal, deadline, reservation, isHls) {
  await new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...(isHls ? ['-f', 'mpegts'] : []), '-i', input,
      '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dest],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    reservation.track(child);
    let error = '';
    child.stderr.on('data', b => { error = (error + b.toString()).slice(-2048); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), Math.max(1, deadline - Date.now()));
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', e => { clearTimeout(timeout); signal.removeEventListener('abort', abort); reject(e); });
    child.on('close', code => {
      clearTimeout(timeout); signal.removeEventListener('abort', abort);
      code === 0 && !signal.aborted && Date.now() <= deadline ? resolve() : reject(new Error(`FFmpeg exit ${code}: ${error}`));
    });
  });
}
async function build(id) {
  if (jobs.has(id)) return jobs.get(id);
  if (await ready(id)) return;
  if (jobs.size >= MAX_CONCURRENT) fail(503, 'DeepLearning.AI conversion capacity reached; retry later');
  const entry = get(id);
  const job = (async () => {
    const reservation = await cache.reserve(MAX_FILE);
    const controller = new AbortController();
    const deadline = Date.now() + MAX_BUILD_MS;
    const timer = setTimeout(() => controller.abort(Error('Media build deadline exceeded')), MAX_BUILD_MS);
    const stamp = `${id}.${process.pid}.${Date.now()}`;
    const input = join(DIR, `${stamp}.partial.m4a.hls-input`);
    const spool = join(DIR, `${stamp}.segments`);
    const partial = join(DIR, `${stamp}.partial.m4a`);
    try {
      await mkdir(DIR, { recursive: true });
      reservation.watch(input); reservation.watch(spool); reservation.watch(partial);
      const isHls = new URL(entry.mediaUrl).pathname.endsWith('.m3u8');
      if (isHls) {
        await downloadHls(entry.mediaUrl, input, spool, MAX_FILE, controller.signal, deadline);
      } else await download(entry.mediaUrl, input, MAX_FILE, controller.signal);
      await reservation.verify();
      await convert(input, partial, controller.signal, deadline, reservation, isHls);
      const size = await stat(partial);
      if (!size.isFile() || size.size < 100) fail(502, 'Invalid or empty M4A output');
      await reservation.verify();
      // Never publish stale audio when registration changes during a build.
      if (registrations.get(id) !== entry) fail(409, 'Media registration changed during conversion; retry');
      await rename(partial, output(id));
    } finally {
      clearTimeout(timer); controller.abort();
      await Promise.allSettled([unlink(input), unlink(partial), rm(spool, { recursive: true, force: true })]);
      reservation.release();
    }
  })();
  jobs.set(id, job);
  try { await job; } finally { jobs.delete(id); }
}
function rangeFor(header, size) {
  if (!header) return { start: 0, end: size - 1, code: 200 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) { const n = Number(m[2]); if (!Number.isSafeInteger(n) || n <= 0) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1), code: 206 };
}
const adapter = {
  id: 'deeplearningai',
  mediaHosts: [CDN],
  mediaTranslationPriority: 10,
  matches(u) { try { lessonUrl(u.href); return true; } catch { return false; } },
  stableMediaPath(u) { return `/media/deeplearningai/${registeredLessonId(lessonUrl(u.href))}/audio.m4a`; },
  async resolve(u) {
    const id = registeredLessonId(lessonUrl(u.href)); get(id);
    return { site: 'deeplearningai', id, contentType: 'audio/mp4', upstreams: [], headers: {}, metadata: { generatedAudio: true } };
  },
  async resolveMediaPath(path) {
    const id = MEDIA.exec(path)?.[1]; if (!id) fail(404, 'Invalid DeepLearning.AI media path');
    get(id);
    return { site: 'deeplearningai', id, contentType: 'audio/mp4', upstreams: [], headers: {}, metadata: { generatedAudio: true } };
  },
  async handleRequest({ req, res, url, base, send }) {
    if (url.pathname === '/api/deeplearningai/register' && req.method === 'POST') {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) fail(413, 'Registration too large'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
      const lesson = lessonUrl(body?.lessonUrl);
      const source = mediaUrl(body?.mediaUrl);
      const canonical = canonicalVideoId(source);
      if (body?.videoId !== canonical.split('/')[1]) fail(400, 'videoId does not match CDN asset');
      if (new URL(lesson).pathname.split('/')[2] !== canonical.split('/')[0]) fail(400, 'Course mismatch');
      const id = canonical.split('/')[1]; // Real HLS asset ID, never a hash or registration token.
      const previousId = lessonIds.get(lesson);
      lessonIds.set(lesson, id);
      if (previousId && previousId !== id) registrations.delete(previousId);
      for (const [k, v] of registrations) if (v.until <= Date.now()) registrations.delete(k);
      if (registrations.size >= 1000 && !registrations.has(id)) registrations.delete(registrations.keys().next().value);
      const old = registrations.get(id);
      if (old && old.canonicalVideoId !== canonical) fail(409, 'Asset ID collision between courses');
      registrations.set(id, { mediaUrl: source, videoId: id, canonicalVideoId: canonical, until: Date.now() + TTL });
      if (old && old.canonicalVideoId !== canonical) {
        const active = jobs.get(id);
        if (active) await active.catch(() => {});
        await unlink(output(id)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      send(200, { mediaUrl: new URL(`/media/deeplearningai/${id}/audio.m4a`, base).href, videoId: id });
      return true;
    }
    const id = MEDIA.exec(url.pathname)?.[1];
    if (!id || !['GET', 'HEAD'].includes(req.method)) return false;
    get(id); cache.retain(id);
    let released = false;
    const release = () => { if (!released) { released = true; cache.release(id); } };
    try {
      await build(id);
      const s = await ready(id); if (!s) fail(502, 'Audio conversion failed');
      const common = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=60' };
      const range = rangeFor(req.headers.range, s.size);
      if (!range) { res.writeHead(416, { ...common, 'Content-Range': `bytes */${s.size}` }); res.end(); release(); return true; }
      const headers = { ...common, 'Content-Length': range.end - range.start + 1 };
      if (range.code === 206) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${s.size}`;
      res.writeHead(range.code, headers);
      if (req.method === 'HEAD') { res.end(); release(); return true; }
      const stream = createReadStream(output(id), { start: range.start, end: range.end });
      stream.on('error', e => res.destroy(e));
      stream.on('close', release);
      res.on('close', () => { stream.destroy(); release(); });
      stream.pipe(res);
    } catch (e) {
      release(); console.error('[deeplearningai] audio:', e);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('DeepLearning.AI audio unavailable'); }
      else res.destroy(e);
    }
    return true;
  },
  async prepareMediaTranslation(body, { publicBaseUrl }) {
    let signed; try { signed = signedProxyMediaUrlFromEnvelope(body); } catch { return null; }
    if (!signed) return null;
    let candidate, base; try { candidate = new URL(signed); base = new URL(publicBaseUrl); } catch { return null; }
    const id = MEDIA.exec(candidate.pathname)?.[1];
    if (!id || candidate.origin !== base.origin || candidate.search || candidate.hash || candidate.username || candidate.password) return null;
    get(id);
    return { body, mediaUrl: candidate.href };
  }
};
export default adapter;
