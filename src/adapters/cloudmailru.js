import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';

const MEDIA = /^\/media\/cloudmailru\/([A-Za-z0-9_-]{4,256})\/audio\.m4a$/;
const registrations = new Map();
const jobs = new Map();
const TTL = 24 * 60 * 60 * 1000;
const LIMIT = 1000;
const CACHE_DIR = process.env.CLOUDMAILRU_CACHE_DIR || join(tmpdir(), 'ump-cloudmailru-m4a');
const MAX_CONCURRENT = 2;
const MAX_BUILD_MS = 20 * 60 * 1000;

function parseManifest(value) {
  let u;
  try { u = new URL(value); } catch { fail(400, 'Invalid Cloud Mail.ru manifest URL'); }
  if (u.protocol !== 'https:' || !/^cloclo[0-9]+\.cloud\.mail\.ru$/i.test(u.hostname) ||
      u.port || u.username || u.password || u.hash ||
      !/^\/(?:video\/(?:0p|[0-9]+p(?:_[0-9]+)?)|videowl\/view\/[A-Za-z0-9_-]+\/g\/[A-Za-z0-9_@.%+-]+\/(?:0p|[0-9]+p(?:_[0-9]+)?))\/[A-Za-z0-9_+=-]+\.m3u8$/i.test(u.pathname) ||
      [...u.searchParams.keys()].some(k => k !== 'double_encode') ||
      (u.searchParams.has('double_encode') && u.searchParams.get('double_encode') !== '1')) {
    fail(400, 'Untrusted Cloud Mail.ru manifest');
  }
  const encoded = /\/([^/]+)\.m3u8$/i.exec(u.pathname)[1];
  const id = encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]{4,256}$/.test(id)) fail(400, 'Invalid Cloud Mail.ru video ID');
  return { id, manifestUrl: u.href };
}
function registered(id) {
  const item = registrations.get(id);
  if (!item || item.expires < Date.now()) {
    registrations.delete(id);
    fail(404, 'Cloud Mail.ru video not registered; reopen the player');
  }
  return item;
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

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  'Origin': 'https://cloud.mail.ru',
  'Referer': 'https://cloud.mail.ru/'
};
const PAGE_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const MAX_PUBLIC_HTML_BYTES = 2 * 1048576;

function parsePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'Invalid Cloud Mail.ru public URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'cloud.mail.ru' || url.port ||
      url.username || url.password || url.search || url.hash) {
    fail(400, 'Untrusted Cloud Mail.ru public URL');
  }
  const match = /^\/public\/([A-Za-z0-9_-]{2,64})\/([A-Za-z0-9_-]{2,128})\/?$/.exec(url.pathname);
  if (!match) fail(400, 'Invalid Cloud Mail.ru public link');
  const weblink = `${match[1]}/${match[2]}`;
  return { publicUrl: `https://cloud.mail.ru/public/${weblink}`, weblink };
}

async function manifestFromPublicUrl(value) {
  const { publicUrl, weblink } = parsePublicUrl(value);
  const response = await fetch(publicUrl, {
    headers: {
      'User-Agent': PAGE_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) fail(502, `Cloud Mail.ru public page HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_PUBLIC_HTML_BYTES) fail(502, 'Cloud Mail.ru public page too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_PUBLIC_HTML_BYTES) fail(502, 'Cloud Mail.ru public page too large');
    chunks.push(chunk);
  }
  const html = Buffer.concat(chunks, size).toString('utf8');
  const match = html.match(/"videowl_view":\{"count":"[^"]+","url":"(https:\/\/cloclo\d+\.cloud\.mail\.ru\/videowl\/view\/[^"]+)"\}/);
  if (!match) fail(502, 'Cloud Mail.ru video token not found');
  const encoded = Buffer.from(weblink).toString('base64');
  const manifest = `${match[1]}/0p/${encoded}.m3u8?double_encode=1`;
  const parsed = parseManifest(manifest);
  // Validate the actual manifest before registration; the token may be stale.
  const master = await fetchLimited(parsed.manifestUrl, MAX_PLAYLIST_BYTES, AbortSignal.timeout(15000), {
    'User-Agent': PAGE_USER_AGENT,
    'Origin': 'https://cloud.mail.ru',
    'Referer': publicUrl,
    'Accept': '*/*'
  });
  if (!master.toString('utf8').startsWith('#EXTM3U')) fail(502, 'Cloud Mail.ru HLS unavailable');
  return parsed;
}

const SEGMENT_CONCURRENCY = 8;
const MAX_SEGMENTS = 500;
const MAX_TOTAL_BYTES = 200 * 1048576;
const MAX_PLAYLIST_BYTES = 2 * 1048576;
const MAX_SEGMENT_BYTES = 8 * 1048576;

function trustedCdnUrl(value, base, extension) {
  const u = new URL(value, base);
  if (u.protocol !== 'https:' || !/^cloclo[0-9]+\.cloud\.mail\.ru$/i.test(u.hostname) ||
      u.port || u.username || u.password || u.hash ||
      !u.pathname.endsWith(extension) ||
      [...u.searchParams.keys()].some(k => k !== 'double_encode') ||
      (u.searchParams.has('double_encode') && u.searchParams.get('double_encode') !== '1')) {
    throw new Error('Untrusted Cloud Mail.ru CDN URL');
  }
  return u.href;
}

async function fetchLimited(url, limit, signal, headers = FETCH_HEADERS) {
  const response = await fetch(url, {
    headers, redirect: 'error', signal
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Cloud Mail.ru HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Cloud Mail.ru response too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Cloud Mail.ru response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function playlistEntries(text) {
  return text.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

async function buildFile(id) {
  if (await readyFile(id)) return;
  if (jobs.has(id)) return jobs.get(id);
  if (jobs.size >= MAX_CONCURRENT) fail(503, 'Cloud Mail.ru conversion capacity reached; retry later');
  const job = (async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    if (await readyFile(id)) return;
    const partial = join(CACHE_DIR, `${id}.${process.pid}.${Date.now()}.partial.m4a`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Cloud Mail.ru build timeout')), MAX_BUILD_MS);
    let ffmpeg;
    let finished;
    try {
      const masterUrl = registered(id).manifestUrl;
      const masterText = (await fetchLimited(masterUrl, MAX_PLAYLIST_BYTES, controller.signal)).toString('utf8');
      if (!masterText.startsWith('#EXTM3U')) throw new Error('Invalid master HLS playlist');
      const variant = playlistEntries(masterText).find(line => /\/240p_[0-9]+\//.test(line));
      if (!variant) throw new Error('Cloud Mail.ru 240p variant not found');
      const variantUrl = trustedCdnUrl(variant, masterUrl, '.m3u8');
      const playlist = (await fetchLimited(variantUrl, MAX_PLAYLIST_BYTES, controller.signal)).toString('utf8');
      if (!playlist.startsWith('#EXTM3U') || !/^#EXT-X-ENDLIST\s*$/m.test(playlist)) {
        throw new Error('Incomplete HLS playlist');
      }
      if (/#EXT-X-(KEY|MAP|BYTERANGE|DISCONTINUITY)\b/.test(playlist)) {
        throw new Error('Unsupported HLS playlist features');
      }
      const segments = playlistEntries(playlist);
      const durations = [...playlist.matchAll(/^#EXTINF:/gm)];
      if (!segments.length || segments.length !== durations.length || segments.length > MAX_SEGMENTS) {
        throw new Error('Invalid HLS segment count');
      }
      const segmentUrls = segments.map(line => trustedCdnUrl(line, variantUrl, '.ts'));

      ffmpeg = spawn('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'mpegts', '-i', 'pipe:0',
        '-map', '0:a:0', '-vn', '-c:a', 'copy',
        '-movflags', '+faststart', '-f', 'mp4', partial
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      ffmpeg.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
      finished = new Promise((resolve, reject) => {
        ffmpeg.on('error', reject);
        ffmpeg.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
        });
      });
      // Prevent an early ffmpeg failure from becoming an unhandled rejection.
      finished.catch(() => {});
      let totalBytes = 0;
      for (let i = 0; i < segmentUrls.length; i += SEGMENT_CONCURRENCY) {
        const batch = await Promise.all(segmentUrls.slice(i, i + SEGMENT_CONCURRENCY)
          .map(url => fetchLimited(url, MAX_SEGMENT_BYTES, controller.signal)));
        for (const data of batch) {
          totalBytes += data.length;
          if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Cloud Mail.ru video exceeds 200 MiB');
          if (ffmpeg.stdin.destroyed) throw new Error('ffmpeg input closed unexpectedly');
          if (!ffmpeg.stdin.write(data)) {
            await Promise.race([
              once(ffmpeg.stdin, 'drain'),
              finished.then(() => { throw new Error('ffmpeg exited before input completed'); }),
              new Promise((_, reject) => controller.signal.addEventListener('abort',
                () => reject(controller.signal.reason), { once: true }))
            ]);
          }
        }
      }
      ffmpeg.stdin.end();
      await finished;
      const result = await stat(partial);
      if (!result.size) throw new Error('Empty M4A');
      await rename(partial, filePath(id));
    } catch (error) {
      controller.abort(error);
      if (ffmpeg) {
        ffmpeg.stdin.destroy();
        ffmpeg.kill('SIGKILL');
        await finished?.catch(() => {});
      }
      await unlink(partial).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  jobs.set(id, job);
  try { await job; } finally { jobs.delete(id); }
}

export const cloudmailru = {
  id: 'cloudmailru',
  mediaHosts: ['cloud.mail.ru'],
  mediaTranslationPriority: 10,
  matches(u) {
    try { parseManifest(u.href); return true; } catch { return false; }
  },
  stableMediaPath(u) {
    return `/media/cloudmailru/${parseManifest(u.href).id}/audio.m4a`;
  },
  async resolve(u) {
    const { id } = parseManifest(u.href);
    const item = registered(id);
    return {
      site: 'cloudmailru', id, contentType: 'application/vnd.apple.mpegurl',
      upstreams: [item.manifestUrl], headers: {}, metadata: { hls: true }
    };
  },
  async resolveMediaPath(path) {
    const m = MEDIA.exec(path);
    if (!m) fail(404, 'Invalid Cloud Mail.ru media path');
    const item = registered(m[1]);
    return this.resolve(new URL(item.manifestUrl));
  },
  async handleRequest({ req, res, url, base, send }) {
    if (url.pathname === '/api/cloudmailru/register' && req.method === 'POST') {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2048) fail(413, 'Cloud Mail.ru registration too large');
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'Invalid JSON'); }
      const { id, manifestUrl } = data?.publicUrl
        ? await manifestFromPublicUrl(data.publicUrl)
        : parseManifest(data?.manifestUrl);
      if (data?.videoId != null && data.videoId !== id) fail(400, 'Cloud Mail.ru video ID mismatch');
      for (const [key, expiry] of registrations) if (expiry.expires < Date.now()) registrations.delete(key);
      if (registrations.size >= LIMIT) registrations.delete(registrations.keys().next().value);
      const previous = registrations.get(id);
      if (!data?.publicUrl && previous && previous.manifestUrl !== manifestUrl) {
        // Preserve legacy registration behavior.
        await unlink(filePath(id)).catch(() => {});
      }
      // Public-link registration preserves cached audio across CDN token refreshes.
      registrations.set(id, { expires: Date.now() + TTL, manifestUrl });
      send(200, { mediaUrl: new URL(`/media/cloudmailru/${id}/audio.m4a`, base).href });
      return true;
    }
    const match = MEDIA.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(req.method)) return false;
    const id = match[1];
    registered(id);
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
          res.writeHead(416, { ...common, 'Content-Range': `bytes */${s.size}` }); res.end(); return true;
        }
        if (!m[1]) {
          const suffix = Number(m[2]);
          if (!Number.isSafeInteger(suffix) || suffix <= 0) {
            res.writeHead(416, { ...common, 'Content-Range': `bytes */${s.size}` }); res.end(); return true;
          }
          start = Math.max(0, s.size - suffix);
        } else {
          start = Number(m[1]);
          if (m[2]) end = Number(m[2]);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= s.size || start > end) {
          res.writeHead(416, { ...common, 'Content-Range': `bytes */${s.size}` }); res.end(); return true;
        }
        end = Math.min(end, s.size - 1);
        status = 206;
      }
      const headers = { ...common, 'Content-Length': end - start + 1 };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${s.size}`;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') { res.end(); return true; }
      const stream = createReadStream(filePath(id), { start, end });
      stream.on('error', e => { console.error('[CloudMailRu] file read:', e); res.destroy(e); });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (e) {
      console.error('[CloudMailRu] M4A preparation failed:', e);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Cloud Mail.ru M4A preparation failed'); }
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
export default cloudmailru;
