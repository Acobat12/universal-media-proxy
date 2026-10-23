import { fail } from '../core/errors.js';
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
export const bilibili = {
  id: 'bilibili',
  mediaHosts: ['bilivideo.com', 'bilibili.com', 'hdslb.com'],
  async prepareMediaTranslation(body, context) {
    // Decline requests for other sites without blocking later adapters.
    // Keep strict validation for requests that actually mention Bilibili.
    if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return null;
    if (!Buffer.from(body).includes(Buffer.from('bilibili.com'))) return null;
    return prepareBilibiliMediaTranslation(body, context);
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
    const play = await json(`${API}/x/player/wbi/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16`, fetcher, signal);
    const tracks = (play.dash?.audio || []).filter(a => a.baseUrl || a.base_url).sort((a,b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (!tracks.length) fail(422, 'No DASH audio track (region/login/WBI may be required)');
    const index = quality === 'lowest' ? tracks.length - 1 : quality === 'medium' ? Math.floor((tracks.length - 1) / 2) : 0;
    const audio = tracks[index];
    const urls = [audio.baseUrl || audio.base_url, ...(audio.backupUrl || audio.backup_url || [])];
    return { site: 'bilibili', id: `${bvid}-p${p}`, contentType: audio.mimeType || 'audio/mp4', upstreams: [...new Set(urls)], headers: HEADERS, metadata: { bvid, cid, page: p, quality, bandwidth: audio.bandwidth || null } };
  }
};

// Bilibili-specific VOT translation integration.
// Media-mode translation request preparation. The VOT API gateway is deliberately separate.

const utf8 = new TextDecoder('utf-8', { fatal: true });
const enc = new TextEncoder();
function readVarint(buf, pos) {
  let val = 0, shift = 0, p = pos;
  for (let i = 0; i < 5; i++) {
    if (p >= buf.length) throw Error('Truncated protobuf');
    const b = buf[p++]; val += (b & 127) * 2 ** shift;
    if (!(b & 128)) return [val, p];
    shift += 7;
  }
  throw Error('Unsupported protobuf varint');
}
function varint(n) {
  const out = [];
  do { const b = n % 128; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
const isBilibili = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && /^(?:www\.)?bilibili\.com$/.test(u.hostname) && /^\/(?:[a-z]{2}(?:-[A-Za-z]{2,8})?\/)?video\/BV[A-Za-z0-9]+(?:\/|$)/i.test(u.pathname); }
  catch { return false; }
};
// Walk protobuf wire fields, including nested messages. Preserve unknown fields byte-for-byte.
export function rewriteBilibiliUrls(buffer, replacement, depth = 0) {
  if (depth > 6 || buffer.length > 1048576) return { bytes: buffer, urls: [] };
  let pos = 0; const out = []; const urls = [];
  try {
    while (pos < buffer.length) {
      const start = pos;
      const [tag, afterTag] = readVarint(buffer, pos); pos = afterTag;
      const wire = tag & 7;
      if (!tag || (tag >>> 3) === 0) throw Error('Invalid field');
      if (wire === 0) { [, pos] = readVarint(buffer, pos); out.push(buffer.subarray(start, pos)); }
      else if (wire === 1 || wire === 5) { pos += wire === 1 ? 8 : 4; if (pos > buffer.length) throw Error('Truncated fixed'); out.push(buffer.subarray(start, pos)); }
      else if (wire === 2) {
        const [length, dataStart] = readVarint(buffer, pos); const end = dataStart + length;
        if (end > buffer.length) throw Error('Truncated bytes');
        const value = buffer.subarray(dataStart, end); pos = end;
        let replaced = null;
        try { const str = utf8.decode(value); if (isBilibili(str)) { urls.push(str); replaced = enc.encode(replacement); } } catch {}
        if (!replaced && depth < 6) {
          const nested = rewriteBilibiliUrls(value, replacement, depth + 1);
          if (nested.urls.length) { urls.push(...nested.urls); replaced = nested.bytes; }
        }
        if (replaced) out.push(buffer.subarray(start, afterTag), varint(replaced.length), replaced);
        else out.push(buffer.subarray(start, end));
      } else throw Error('Unsupported wire type');
    }
    return { bytes: Buffer.concat(out), urls };
  } catch { return { bytes: buffer, urls: [] }; }
}
// The browser VOT client sends a protobuf envelope (headers=1, body=2, path=3).
// Rewrite only field 2; never confuse header strings with the translation payload.
export function rewriteEnvelopeMedia(body, replacement, expectedPath = '/video-translation/translate') {
  let pos = 0, path = null, bodyCount = 0, sourceVideoUrl = null;
  const chunks = [], urls = [];
  while (pos < body.length) {
    const start = pos;
    const [tag, afterTag] = readVarint(body, pos);
    if ((tag & 7) !== 2 || ![1, 2, 3, 4].includes(tag >>> 3)) throw Error('Invalid VOT envelope');
    const [length, dataStart] = readVarint(body, afterTag);
    const end = dataStart + length;
    if (end > body.length) throw Error('Truncated VOT envelope');
    const field = tag >>> 3;
    if (field === 3) path = utf8.decode(body.subarray(dataStart, end));
    if (field === 4) {
      if (sourceVideoUrl !== null) throw Error("Duplicate source video URL");
      sourceVideoUrl = utf8.decode(body.subarray(dataStart, end));
      if (!isBilibili(sourceVideoUrl)) throw Error("Invalid Bilibili source URL");
    }
    if (field === 2) {
      bodyCount++;
      const rewritten = rewriteBilibiliUrls(body.subarray(dataStart, end), replacement);
      urls.push(...rewritten.urls);
      chunks.push(body.subarray(start, afterTag), varint(rewritten.bytes.length), rewritten.bytes);
    } else chunks.push(body.subarray(start, end));
    pos = end;
  }
  if (path !== expectedPath || bodyCount !== 1) throw Error('Unexpected VOT envelope path or body');
  return { bytes: Buffer.concat(chunks), urls, sourceVideoUrl };
}
export function canonicalBilibiliVideo(value) {
  if (!isBilibili(value)) throw Error('Invalid Bilibili video URL');
  const u = new URL(value);
  const match = u.pathname.match(/\/video\/(BV[A-Za-z0-9]+)(?:\/|$)/i);
  const raw = u.searchParams.get('p') || '1';
  const page = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(page) || page > 1000) throw Error('Invalid Bilibili part');
  return { bvid: match[1], page, sourceUrl: `https://www.bilibili.com/video/${match[1]}/?p=${page}` };
}
export function stableMediaUrl(videoUrl, publicBaseUrl) {
  const { bvid, page } = canonicalBilibiliVideo(videoUrl);
  return new URL(`/media/bilibili/${bvid}/p${page}/audio.m4a`, publicBaseUrl).href;
}
import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';
export async function prepareBilibiliMediaTranslation(body, { publicBaseUrl }) {
  // No network call here. Media is fetched only if the stable URL is requested.
  const found = rewriteEnvelopeMedia(body, 'https://placeholder.invalid/media');
  const unique = [...new Set(found.urls)];
  const videoUrl = found.sourceVideoUrl || (unique.length === 1 ? unique[0] : null);
  if (!videoUrl) throw Error(`Missing Bilibili source URL (protobuf matches: ${unique.length}); update VOT client`);
  if (unique.length && (unique.length !== 1 || unique[0] !== videoUrl)) throw Error('Conflicting Bilibili URLs in request');
  const mediaUrl = stableMediaUrl(videoUrl, publicBaseUrl);
  // The UserScript generated this URL before signing. Preserve the exact bytes.
  if (found.sourceVideoUrl && unique.length === 0) {
    const signedUrl = signedProxyMediaUrlFromEnvelope(body);
    if (signedUrl === mediaUrl) {
      console.log('[MEDIA MODE] signed proxy media URL accepted; forwarding unchanged');
      return { body, mediaUrl };
    }
  }

  if (!unique.length) throw Error('Bilibili URL supplied as metadata, but the signed Yandex protobuf contains no replaceable URL; cannot substitute media URL without changing the signing flow');
  return { body: rewriteEnvelopeMedia(body, mediaUrl).bytes, mediaUrl };
}

