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

export const bilibili = {
  id: 'bilibili',
  async handleRequest({ req, url, base, send }) {
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
  mediaHosts: ['bilivideo.com', 'bilibili.com', 'hdslb.com'],
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
        !/^\/media\/bilibili\/BV[A-Za-z0-9]{8,20}\/p(?:[1-9]\d{0,2}|1000)\/audio\.m4a$/.test(candidate.pathname) ||
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
