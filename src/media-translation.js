// Media-mode translation request preparation. The VOT API gateway is deliberately separate.
import { extractAudio } from './core/extraction.js';
import { Registry } from './core/registry.js';
import { bilibili } from './adapters/bilibili.js';
import { assertPublicUrl } from './core/security.js';
import { sign } from './core/token.js';

const registry = new Registry().register(bilibili);
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
// Accept only the canonical proxy URL in protobuf field 3, already signed by the client.
function signedProxyMediaUrl(payload) {
  let pos = 0, result = null;
  while (pos < payload.length) {
    const [tag, afterTag] = readVarint(payload, pos);
    const field = tag >>> 3, wire = tag & 7;
    if (!field) throw Error('Invalid protobuf field');
    pos = afterTag;
    if (wire === 0) { [, pos] = readVarint(payload, pos); }
    else if (wire === 1 || wire === 5) pos += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const [len, start] = readVarint(payload, pos);
      pos = start + len;
      if (pos > payload.length) throw Error('Truncated protobuf');
      if (field === 3) {
        if (result !== null) throw Error('Duplicate protobuf video URL');
        result = utf8.decode(payload.subarray(start, pos));
      }
    } else throw Error('Unsupported protobuf wire type');
    if (pos > payload.length) throw Error('Truncated protobuf');
  }
  return result;
}

function signedProxyMediaUrlFromEnvelope(envelope) {
  let pos = 0, result = null;
  while (pos < envelope.length) {
    const [tag, next] = readVarint(envelope, pos);
    if ((tag & 7) !== 2) throw Error('Invalid VOT envelope');
    const [len, start] = readVarint(envelope, next);
    const end = start + len;
    if (end > envelope.length) throw Error('Truncated VOT envelope');
    if ((tag >>> 3) === 2) {
      if (result !== null) throw Error('Duplicate envelope body');
      result = signedProxyMediaUrl(envelope.subarray(start, end));
    }
    pos = end;
  }
  return result;
}

export async function prepareMediaTranslation(body, { publicBaseUrl }) {
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
