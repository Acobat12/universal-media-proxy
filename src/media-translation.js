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
  try { const u = new URL(value); return u.protocol === 'https:' && /^(?:www\.)?bilibili\.com$/.test(u.hostname) && /^\/video\/BV[A-Za-z0-9]+\//.test(u.pathname + '/'); }
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
export async function prepareMediaTranslation(body, { publicBaseUrl, secret, fetcher = fetch, allowedHosts, download }) {
  // Discover URL first; do not mutate the signed request until media is available.
  const found = rewriteBilibiliUrls(body, 'https://placeholder.invalid/media');
  const unique = [...new Set(found.urls)];
  if (unique.length !== 1) throw Error(`Expected exactly one Bilibili URL in translation protobuf; found ${unique.length}`);
  const videoUrl = unique[0];
  const source = await extractAudio(new URL(videoUrl), { registry, fetcher, quality: 'best', signal: AbortSignal.timeout(20000) });
  for (const candidate of source.upstreams) await assertPublicUrl(candidate, allowedHosts);
  const exp = Date.now() + 900000;
  const token = sign({ site: source.site, videoUrl, quality: 'best', upstreams: source.upstreams, headers: source.headers, contentType: source.contentType, mode: 'disk', exp }, secret);
  const mediaUrl = new URL(`/media/${token}`, publicBaseUrl).href;
  await download(mediaUrl); // Must finish download before sending the URL to Yandex.
  return { body: rewriteBilibiliUrls(body, mediaUrl).bytes, mediaUrl };
}
