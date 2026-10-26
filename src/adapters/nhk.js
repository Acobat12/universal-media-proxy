import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';

const MEDIA = /^\/media\/nhk\/([0-9]{12,24})\/audio\.m4a$/;
const registrations = new Map();
const jobs = new Map();
const TTL = 24 * 60 * 60 * 1000;
const LIMIT = 1000;
const CACHE_DIR = process.env.NHK_CACHE_DIR || join(tmpdir(), 'ump-nhk-m4a');
const MAX_CONCURRENT = 2;
const MAX_BUILD_MS = 20 * 60 * 1000;

function manifestFromId(id) {
  return `https://masterpl.hls.nhkworld.jp/hls/w/${id}/master_nocc.m3u8`;
}
function parseManifest(value) {
  let u;
  try { u = new URL(value); } catch { fail(400, 'Invalid NHK manifest URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'masterpl.hls.nhkworld.jp' ||
      u.port || u.username || u.password || u.search || u.hash) fail(400, 'Untrusted NHK manifest');
  const m = /^\/hls\/w\/([0-9]{12,24})\/master_nocc\.m3u8$/.exec(u.pathname);
  if (!m) fail(400, 'Unsupported NHK manifest path');
  return m[1];
}
function registered(id) {
  const expiry = registrations.get(id);
  if (!expiry || expiry < Date.now()) {
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
async function buildFile(id) {
  if (await readyFile(id)) return;
  if (jobs.has(id)) return jobs.get(id);
  if (jobs.size >= MAX_CONCURRENT) fail(503, 'NHK conversion capacity reached; retry later');
  const job = (async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    if (await readyFile(id)) return;
    const partial = join(CACHE_DIR, `${id}.${process.pid}.${Date.now()}.partial.m4a`);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-i', manifestFromId(id),
          '-map', '0:a:0', '-vn', '-c:a', 'copy',
          '-movflags', '+faststart', '-f', 'mp4', partial
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => child.kill('SIGKILL'), MAX_BUILD_MS);
        child.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-2000); });
        child.on('error', e => { if (!settled) { settled = true; reject(e); } });
        child.on('close', code => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
        });
      });
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

export const nhk = {
  id: 'nhk',
  mediaHosts: ['masterpl.hls.nhkworld.jp', 'media-tyo.hls.nhkworld.jp'],
  mediaTranslationPriority: 10,
  matches(u) {
    return u.protocol === 'https:' && u.hostname === 'masterpl.hls.nhkworld.jp' &&
      /^\/hls\/w\/[0-9]{12,24}\/master_nocc\.m3u8$/.test(u.pathname);
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
      for (const [key, expiry] of registrations) if (expiry < Date.now()) registrations.delete(key);
      if (registrations.size >= LIMIT) registrations.delete(registrations.keys().next().value);
      registrations.set(id, Date.now() + TTL);
      send(200, { mediaUrl: new URL(`/media/nhk/${id}/audio.m4a`, base).href });
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
      stream.on('error', e => { console.error('[NHK] file read:', e); res.destroy(e); });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (e) {
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
