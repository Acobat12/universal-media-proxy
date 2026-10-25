import { withTikTokPage } from '../core/tiktok-browser.js';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fail } from '../core/errors.js';
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';

const VIDEO_ID = /^\d{10,25}$/;
const MEDIA_PATH = /^\/media\/tiktok\/(\d{10,25})\/video\.mp4$/;
const registrations = new Map();
// Persist only public page URLs and expiry; never persist CDN sessions or cookies.
const STORE_PATH = resolvePath(process.env.TIKTOK_REGISTRATIONS_FILE || '/var/cache/universal-media-proxy/tiktok-registrations.json');
function diagnostic(reason, details = {}) {
  console.log('[TIKTOK DIAG]', JSON.stringify({ reason, registrations: registrations.size, ...details }));
}
function loadRegistrations() {
  try {
    const records = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    if (!Array.isArray(records)) throw new Error('Expected an array');
    for (const item of records) {
      if (VIDEO_ID.test(String(item?.videoId)) && typeof item.pageUrl === 'string' &&
          Number.isFinite(item.until) && item.until > Date.now() && registrations.size < MAX_ENTRIES) {
        try {
          const u = new URL(item.pageUrl);
          if (u.protocol === 'https:' && u.hostname === 'www.tiktok.com' &&
              u.pathname.endsWith('/video/' + item.videoId) && !u.search && !u.hash) {
            registrations.set(String(item.videoId), { pageUrl: u.origin + u.pathname, until: item.until });
          }
        } catch {}
      }
    }
    diagnostic('registrations-loaded');
  } catch (err) {
    if (err.code !== 'ENOENT') diagnostic('registrations-load-failed', { error: err.message?.slice(0, 120) });
  }
}
let saveRunning = false;
let saveDirty = false;
async function flushRegistrations() {
  if (saveRunning) return;
  saveRunning = true;
  try {
    while (saveDirty) {
      saveDirty = false;
      try {
        await mkdir(dirname(STORE_PATH), { recursive: true });
        const data = [...registrations].map(([videoId, item]) => ({ videoId, pageUrl: item.pageUrl, until: item.until }));
        const temp = `${STORE_PATH}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
        await rename(temp, STORE_PATH);
      } catch (err) {
        diagnostic('registrations-save-failed', { error: err.message?.slice(0, 120) });
      }
    }
  } finally { saveRunning = false; }
}
function persistRegistrations() {
  saveDirty = true;
  void flushRegistrations();
}
function getRegistration(videoId) {
  const item = registrations.get(videoId);
  if (item && item.until <= Date.now()) {
    registrations.delete(videoId);
    persistRegistrations();
    diagnostic('registration-expired', { videoId });
    return null;
  }
  return item || null;
}

const pending = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;
const BROWSER_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || undefined;
const HEADERS = { Referer: 'https://www.tiktok.com/', Accept: '*/*' };
const CDN_DOMAINS = ['tiktok.com','tiktokcdn.com','tiktokcdn-eu.com','tiktokv.com','tiktokv.eu','tiktokv.us','tiktokvapp.eu','tiktokeu-cdn.com','byteicdn.com','ibytedtos.com','muscdn.com','ttwstatic.com'];
loadRegistrations();
function isTikTokCdn(host) {
  return CDN_DOMAINS.some(d => host === d || host.endsWith('.' + d)) && host !== 'www.tiktok.com' && host !== 'tiktok.com';
}
function validateMediaUrl(value) {
  let u;
  try { u = new URL(value); } catch { fail(502, 'Invalid TikTok CDN URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !isTikTokCdn(u.hostname) || !/\/video\/tos\/|\/tos-|\/video\/|\/obj\//i.test(u.pathname)) fail(502, 'Unsupported TikTok CDN URL');
  return u.href;
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) fail(413, 'Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Invalid JSON'); }
}
async function resolveVideo(videoId) {
  if (pending.has(videoId)) return pending.get(videoId);
  const task = withTikTokPage(async (page, context) => {
    const candidates = new Map();
    page.on('response', response => {
      try {
        const u = new URL(response.url());
        if (u.hostname === 'sf16-website-login.neutral.ttwstatic.com') {
          diagnostic('video-candidate-ignored', {
            videoId,
            reason: 'tiktok-static-login-media',
            host: u.hostname
          });
          return;
        }
        if (!isTikTokCdn(u.hostname) || !/\/video\/tos\/|\/tos-|\/video\/|\/obj\//i.test(u.pathname)) return;
        if (![200, 206].includes(response.status())) return;
        const type = (response.headers()['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        // TikTok serves thumbnails from the same CDN and even from /video/tos/ paths.
        // Only a response identified as video is eligible; never choose images by URL alone.
        if (type === 'video/mp4') candidates.set(u.href, type);
        else if (type === 'application/octet-stream' && /\/video\/|\/video\/tos\//i.test(u.pathname)) {
          candidates.set(u.href, type);
        }
      } catch {}
    });
    await page.goto(getRegistration(videoId)?.pageUrl || `https://www.tiktok.com/@tiktok/video/${videoId}`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    // Wait only until candidates appear; never impose a fixed five-second delay.
    const deadline = Date.now() + 5000;
    while (candidates.size === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    // Do not add __VIDEO_PRELOAD__ blindly: it has no verified response MIME type.
    for (const [candidate, mediaType] of candidates) {
      let url;
      try { url = validateMediaUrl(candidate); } catch { continue; }
      const cookies = await context.cookies(url);
      diagnostic('video-candidate-selected', { videoId, mediaType, host: new URL(url).hostname });
      return {
        url, cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
        userAgent: await page.evaluate(() => navigator.userAgent), obtained: Date.now()
      };
    }
    diagnostic('video-candidates-not-found', { videoId });
    fail(502, 'TikTok CDN video response not found in browser session');
  }).finally(() => pending.delete(videoId));
  pending.set(videoId, task);
  return task;
}
async function serveVideo(req, res, videoId) {
  const item = getRegistration(videoId);
  if (!item) { diagnostic('media-registration-not-found', { videoId }); fail(404, 'TikTok video not registered'); }
  let session = item.session;
  if (!session || Date.now() - session.obtained > 3 * 60 * 1000) session = item.session = await resolveVideo(videoId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { ...HEADERS, 'User-Agent': session.userAgent };
    if (session.cookie) headers.Cookie = session.cookie;
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(session.url, { headers, redirect: 'manual', signal: AbortSignal.timeout(90000) });
    const contentType = upstream.headers.get('content-type') || '';
    diagnostic('cdn-response', {
  videoId,
  status: upstream.status,
  contentType,
  contentLength: upstream.headers.get('content-length'),
  finalHost: new URL(upstream.url).hostname
});
    if ((upstream.status === 403 || upstream.status === 410) && attempt === 0) {
      await upstream.body?.cancel();
      session = item.session = await resolveVideo(videoId);
      continue;
    }
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    const isVideo = mediaType === 'video/mp4' ||
      (mediaType === 'application/octet-stream' && /\/video\/|\/video\/tos\//i.test(new URL(session.url).pathname));
    if (![200, 206].includes(upstream.status) || !isVideo) {
      await upstream.body?.cancel();
      diagnostic('cdn-rejected', { videoId, status: upstream.status, contentType });
      if (attempt === 0) {
        item.session = null;
        session = item.session = await resolveVideo(videoId);
        continue;
      }
      fail(502, `TikTok CDN rejected: HTTP ${upstream.status}, type ${mediaType || 'missing'}`);
    }
    const responseHeaders = {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    };
    for (const h of ['content-length','content-range']) {
      const v = upstream.headers.get(h);
      if (v) responseHeaders[h] = v;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (req.method === 'HEAD') { await upstream.body?.cancel(); res.end(); return; }
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    await pipeline(Readable.fromWeb(upstream.body), res);
    return;
  }
}
export const tiktok = {
  id: 'tiktok',
  mediaHosts: CDN_DOMAINS,
  async handleRequest({ req, res, url, base, send }) {
    const match = MEDIA_PATH.exec(url.pathname);
    if (match && ['GET','HEAD'].includes(req.method)) {
      await serveVideo(req, res, match[1]);
      return true;
    }
    if (url.pathname !== '/api/tiktok/register' || req.method !== 'POST') return false;
    const body = await readJson(req);
    const videoId = String(body?.videoId || '');
    if (!VIDEO_ID.test(videoId)) fail(400, 'Invalid TikTok videoId');
    if (body.cookie || body.mediaUrl) fail(400, 'Only videoId and pageUrl are accepted');
    let pageUrl;
    try { const u = new URL(body.pageUrl); if (u.protocol !== 'https:' || u.hostname !== 'www.tiktok.com' || !u.pathname.endsWith('/video/' + videoId) || u.username || u.password || u.port) throw Error(); pageUrl = u.origin + u.pathname; } catch { fail(400, 'Invalid TikTok pageUrl'); }
    if (registrations.size >= MAX_ENTRIES && !registrations.has(videoId)) registrations.delete(registrations.keys().next().value);
    // Registration only records the page URL. CDN resolution happens on the first MP4 request.
    const previous = getRegistration(videoId);
    const samePage = previous?.pageUrl === pageUrl;
    const itemForRegistration = samePage ? previous : { pageUrl };
    itemForRegistration.until = Date.now() + TTL_MS;
    registrations.set(videoId, itemForRegistration);
    persistRegistrations();
    diagnostic('registration-received', { videoId, cached: Boolean(samePage && previous?.session) });
    send(200, { mediaUrl: new URL(`/media/tiktok/${videoId}/video.mp4`, base).href, expiresIn: TTL_MS / 1000 });
    diagnostic('registration-acknowledged', { videoId });
    return true;
  },
  stableMediaPath() { fail(422, 'TikTok media must be registered first'); },
  async resolveMediaPath(path) {
    const match = MEDIA_PATH.exec(path);
    if (!match || !getRegistration(match[1])) fail(404, 'TikTok registration not found');
    return { site: 'tiktok', id: match[1], contentType: 'video/mp4', upstreams: [] };
  },
  mediaTranslationPriority: 10,
  async prepareMediaTranslation(body, { publicBaseUrl }) {
    // Diagnostic metadata only: never log full URLs, tokens, cookies or protobuf bodies.
    const debug = (reason, details = {}) => console.log('[TIKTOK DIAG]', JSON.stringify({
      reason, registrations: registrations.size, ...details
    }));
    if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      debug('invalid-body-type'); return null;
    }
    let signed;
    try { signed = signedProxyMediaUrlFromEnvelope(body); }
    catch (err) { debug('protobuf-parse-failed', { error: err?.message?.slice(0, 100) }); return null; }
    if (!signed) { debug('protobuf-video-url-missing'); return null; }
    let candidate, base;
    try { candidate = new URL(signed); base = new URL(publicBaseUrl); }
    catch { debug('invalid-url-or-public-base'); return null; }
    const details = {
      urlHost: candidate.hostname,
      expectedHost: base.hostname,
      pathKind: MEDIA_PATH.test(candidate.pathname) ? 'tiktok-registered-mp4' : 'other',
      hasQuery: Boolean(candidate.search),
      hasHash: Boolean(candidate.hash)
    };
    if (candidate.origin !== base.origin) { debug('origin-mismatch', details); return null; }
    if (!MEDIA_PATH.test(candidate.pathname)) { debug('path-mismatch', details); return null; }
    if (candidate.search || candidate.hash || candidate.username || candidate.password) {
      debug('url-extra-components', details); return null;
    }
    const id = MEDIA_PATH.exec(candidate.pathname)[1];
    const item = getRegistration(id);
    if (!item) { debug('registration-not-found', details); return null; }
    
    debug('accepted', { ...details, source: 'server-playwright' });
    return { body, mediaUrl: candidate.href };
  },
  matches(u) { return isTikTokCdn(u.hostname); },
  async resolve(u) {
    fail(422, 'TikTok direct CDN URLs are not supported');
  }
};
