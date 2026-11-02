import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fail } from '../core/errors.js';
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';
const SITE = ['www.bilibili.com', 'bilibili.com'];
const API = 'https://api.bilibili.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Origin': 'https://www.bilibili.com',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};
function videoId(u) { return u.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2,8})?\/)?video\/(BV[0-9A-Za-z]+)/i)?.[1]; }
async function json(url, fetcher, signal) {
  const r = await fetcher(url, { headers: HEADERS, signal, redirect: 'manual' });
  if (!r.ok) fail(502, `Bilibili API HTTP ${r.status}`);
  const body = await r.json();
  if (body.code !== 0) fail(502, `Bilibili API error ${body.code}: ${String(body.message).slice(0, 120)}`);
  return body.data;
}
// Registration mirrors Douyin's helper-to-UMP handshake. It does not change
// the binary Protobuf requirement of /video-translation/translate.
const bilibiliRegistrations = new Map();
const BILIBILI_REGISTRATION_TTL = 24 * 60 * 60 * 1000;


// Cheese/Bangumi registrations are ephemeral and scoped to the running process.
const directRegistrations = new Map();
const directJobs = new Map();
const DIRECT_TTL = 30 * 60 * 1000;
const MAX_DIRECT_BYTES = 256 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const CACHE = join(process.env.DISK_CACHE_DIR || join(tmpdir(), 'universal-media-proxy-cache'), 'bilibili-direct');
function safeCdn(value) {
  let u;
  try { u = new URL(value); } catch { fail(400, 'Invalid CDN URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      !(/^(?:[a-z0-9-]+\.)+(?:bilivideo\.com|hdslb\.com)$/i.test(u.hostname) || u.hostname === "upos-hz-mirrorakam.akamaized.net") ||
      !/\.(?:mp4|m4s)(?:$)/i.test(u.pathname)) fail(400, 'CDN URL not allowed');
  return u.href;
}
function directPath(kind, id) { return `/media/bilibili/${kind}/${id}/audio.m4a`; }
async function downloadDirect(entry, output) {
  const controller = new AbortController();
  const headers = { ...HEADERS, Range: 'bytes=0-0' };
  const probe = await fetch(entry.sourceUrl, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (probe.status !== 206) fail(502, `CDN probe HTTP ${probe.status}`);
  const m = /^bytes 0-0\/(\d+)$/.exec(probe.headers.get('content-range') || '');
  await probe.body?.cancel();
  const size = Number(m?.[1]);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_DIRECT_BYTES) fail(413, 'CDN file too large or unknown');
  const input = `${output}.input.mp4`;
  const tmp = `${output}.partial.m4a`;
  const fh = await open(input, 'w', 0o600);
  try {
    await fh.truncate(size);
    let next = 0;
    const count = Math.ceil(size / CHUNK);
    async function worker() {
      while (next < count) {
        const index = next++;
        const start = index * CHUNK, end = Math.min(size - 1, start + CHUNK - 1);
        let done = false;
        for (let attempt = 0; attempt < 5 && !done; attempt++) {
          try {
            const r = await fetch(entry.sourceUrl, {
              headers: { ...HEADERS, Range: `bytes=${start}-${end}` },
              redirect: 'manual', signal: AbortSignal.timeout(20000)
            });
            if (r.status !== 206 || r.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) {
              await r.body?.cancel(); throw Error(`Invalid CDN range response: ${r.status}`);
            }
            const b = Buffer.from(await r.arrayBuffer());
            if (b.length !== end - start + 1) throw Error('Incomplete CDN chunk');
            await fh.write(b, 0, b.length, start);
            done = true;
          } catch (err) {
            if (attempt === 4) throw err;
            await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(32, count) }, worker));
  } finally { await fh.close(); }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-map', '0:a:0', '-vn', '-c:a', 'copy', '-movflags', '+faststart', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-2048); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(Error(`ffmpeg failed (${code}): ${stderr}`)));
    });
    await rename(tmp, output);
  } finally { await rm(input, { force: true }); await rm(tmp, { force: true }); }
}
async function serveDirect(req, res, path) {
  const entry = directRegistrations.get(path);
  if (!entry || entry.until < Date.now()) fail(404, 'Bilibili registration expired');
  await mkdir(CACHE, { recursive: true, mode: 0o700 });
  const output = join(CACHE, `${createHash('sha256').update(path + '\0' + entry.sourceUrl).digest('hex')}.m4a`);
  if (!directJobs.has(output)) {
    const job = (async () => {
      try { if ((await stat(output)).size > 0) return; } catch {}
      await downloadDirect(entry, output);
    })();
    directJobs.set(output, job);
    job.finally(() => directJobs.delete(output)).catch(() => {});
  }
  await directJobs.get(output);
  const size = (await stat(output)).size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
    }
    if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); }
    else { start = Number(match[1]); end = match[2] ? Number(match[2]) : end; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
    }
    end = Math.min(end, size - 1); status = 206;
  }
  res.writeHead(status, { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1, ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    'Cache-Control': 'private, max-age=60' });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(output, { start, end }).on('error', e => res.destroy(e)).pipe(res);
}

export const bilibili = {
  id: 'bilibili',
  async handleRequest({ req, res, url, base, send }) {
    if (/^\/media\/bilibili\/(?:cheese|bangumi)\/[A-Za-z0-9_-]+\/audio\.m4a$/.test(url.pathname) && ['GET', 'HEAD'].includes(req.method)) {
      await serveDirect(req, res, url.pathname); return true;
    }
    if (url.pathname !== '/api/bilibili/register' || req.method !== 'POST') return false;
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2048) fail(413, 'Request too large');
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail(400, 'Invalid JSON'); }
    if (data?.type === 'cheese' || data?.type === 'bangumi') {
      const kind = data.type;
      const id = String(data.videoId || '');
      if (!/^(?:ss|ep)[0-9]{1,20}$/.test(id)) fail(400, 'Invalid Cheese/Bangumi ID');
      const sourceUrl = safeCdn(data.sourceUrl);
      const path = directPath(kind, id);
      for (const [k, v] of directRegistrations) if (v.until < Date.now()) directRegistrations.delete(k);
      if (directRegistrations.size >= 2000) directRegistrations.delete(directRegistrations.keys().next().value);
      directRegistrations.set(path, { sourceUrl, until: Date.now() + DIRECT_TTL });
      send(200, { mediaUrl: new URL(path, base).href }); return true;
    }
    const bvid = String(data?.bvid || '');
    const page = Number(data?.page ?? 1);
    if (!/^BV[A-Za-z0-9]{8,20}$/.test(bvid) || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
      fail(400, 'Invalid Bilibili video identifiers');
    }
    const key = `${bvid}:p${page}`;
    if (bilibiliRegistrations.size > 2000) {
      for (const [id, entry] of bilibiliRegistrations) {
        if (entry.until <= Date.now()) bilibiliRegistrations.delete(id);
      }
      if (bilibiliRegistrations.size > 2000) bilibiliRegistrations.delete(bilibiliRegistrations.keys().next().value);
    }
    bilibiliRegistrations.set(key, { until: Date.now() + BILIBILI_REGISTRATION_TTL });
    send(200, { mediaUrl: new URL(`/media/bilibili/${bvid}/p${page}/audio.m4a`, base).href });
    return true;
  },
  mediaHosts: ['bilivideo.com', 'bilibili.com', 'hdslb.com', 'upos-hz-mirrorakam.akamaized.net'],
  stableMediaPath(url) {
    const { bvid, page } = canonicalBilibiliVideo(url.href);
    return `/media/bilibili/${bvid}/p${page}/audio.m4a`;
  },
  async resolveMediaPath(path, context) {
    const match = /^\/media\/bilibili\/(BV[A-Za-z0-9]+)\/p([1-9]\d{0,3})\/audio\.m4a$/.exec(path);
    if (!match || Number(match[2]) > 1000) fail(404, 'Invalid Bilibili media path');
    return this.resolve(new URL(`https://www.bilibili.com/video/${match[1]}/?p=${match[2]}`), context);
  },
  mediaTranslationPriority: 10,
  async prepareMediaTranslation(body, { publicBaseUrl }) {
    // As with Douyin: the media URL must already be inside the signed
    // Yandex protobuf. Never rewrite signed bytes using envelope metadata.
    if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return null;
    let signed;
    try { signed = signedProxyMediaUrlFromEnvelope(body); }
    catch { return null; }
    if (!signed) return null;
    let candidate, base;
    try { candidate = new URL(signed); base = new URL(publicBaseUrl); }
    catch { return null; }
    if (candidate.origin !== base.origin ||
        !(/\/media\/bilibili\/BV[A-Za-z0-9]{8,20}\/p(?:[1-9]\d{0,2}|1000)\/audio\.m4a$/.test(candidate.pathname) || /^\/media\/bilibili\/(?:cheese|bangumi)\/(?:ss|ep)[0-9]{1,20}\/audio\.m4a$/.test(candidate.pathname)) ||
        candidate.search || candidate.hash || candidate.username || candidate.password) return null;
    console.log('[MEDIA MODE] Bilibili signed proxy media URL accepted; forwarding unchanged');
    return { body, mediaUrl: candidate.href };
  },
  matches(u) { return SITE.includes(u.hostname.toLowerCase()) && !!videoId(u); },
  async resolve(u, { fetcher = fetch, signal, quality = 'best' } = {}) {
    const bvid = videoId(u);
    const p = Number(u.searchParams.get('p') || '1');
    if (!Number.isSafeInteger(p) || p < 1 || p > 1000) fail(400, 'Invalid page number');
    if (!['best','medium','lowest'].includes(quality)) fail(400, 'Invalid audio quality');
    const view = await json(`${API}/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, fetcher, signal);
    // Bilibili pagelist returns an array; legacy fixtures and some wrappers use { pages: [...] }.
    const pages = Array.isArray(view) ? view : view?.pages;
    const cid = pages?.[p - 1]?.cid;
    if (!Number.isSafeInteger(cid) || cid <= 0) fail(404, 'Video part not found');
    // WBI endpoint: may require signing or account access for some videos.
    const play = await json(`${API}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16`, fetcher, signal);
    const tracks = (play.dash?.audio || []).filter(a => a.baseUrl || a.base_url).sort((a,b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (!tracks.length) fail(422, 'No DASH audio track (region/login/WBI may be required)');
    const index = quality === 'lowest' ? tracks.length - 1 : quality === 'medium' ? Math.floor((tracks.length - 1) / 2) : 0;
    const audio = tracks[index];
    const urls = [audio.baseUrl || audio.base_url, ...(audio.backupUrl || audio.backup_url || [])];
    const upstreams = [...new Set(urls)].filter(value => {
      try {
        const u = new URL(value);
        const host = u.hostname.toLowerCase();
        return u.protocol === 'https:' && !u.username && !u.password &&
          (!u.port || u.port === '443') &&
          this.mediaHosts.some(domain => host === domain || host.endsWith('.' + domain));
      } catch { return false; }
    });
    if (!upstreams.length) fail(502, 'No allowed Bilibili audio CDN');
    return { site: 'bilibili', id: `${bvid}-p${p}`, contentType: audio.mimeType || 'audio/mp4', upstreams, headers: HEADERS, metadata: { bvid, cid, page: p, quality, bandwidth: audio.bandwidth || null } };
  }
};

// Bilibili-specific URL validation. Translation uses the signed URL directly.
export function canonicalBilibiliVideo(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !/^(?:www\.)?bilibili\.com$/i.test(u.hostname)) throw Error('Invalid Bilibili video URL');
  const match = u.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2,8})?\/)?video\/(BV[A-Za-z0-9]{8,20})(?:\/|$)/i);
  if (!match) throw Error('Invalid Bilibili video URL');
  const raw = u.searchParams.get('p') || '1';
  const page = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(page) || page > 1000) throw Error('Invalid Bilibili part');
  return { bvid: match[1], page, sourceUrl: `https://www.bilibili.com/video/${match[1]}/?p=${page}` };
}
export function stableMediaUrl(videoUrl, publicBaseUrl) {
  const { bvid, page } = canonicalBilibiliVideo(videoUrl);
  return new URL(`/media/bilibili/${bvid}/p${page}/audio.m4a`, publicBaseUrl).href;
}
