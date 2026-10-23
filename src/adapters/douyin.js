import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';
import { fail } from '../core/errors.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Referer': 'https://www.douyin.com/',
  'Accept': '*/*'
};
const AWEME = /^\d{16,22}$/;
const VIDEO = /^v[a-zA-Z0-9_-]{10,}$/;

export function validateDouyinIds(awemeId, videoId) {
  if (!AWEME.test(String(awemeId || '')) || !VIDEO.test(String(videoId || ''))) fail(400, 'Invalid Douyin identifiers');
}

const registrations = new Map();
const resolveJobs = new Map();
const REGISTRATION_TTL = 24 * 60 * 60 * 1000;

export const douyin = {
  id: 'douyin',
  mediaHosts: ['douyinvod.com', 'douyin.com', 'bytecdn.cn', 'byteimg.com', 'douyincdn.com'],
  async handleRequest({ req, res, url, base, send, fetcher, mediaFetcher,
    effectiveAllowedHosts, maxBytes, parallelThreads, parallelChunkBytes,
    assertPublicUrl, parallelAudio }) {
    if (url.pathname === '/api/douyin/register' && req.method === 'POST') {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) fail(413, 'Request too large');
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'Invalid JSON'); }
      const awemeId = String(data?.awemeId || '');
      const videoId = String(data?.videoId || '');
      validateDouyinIds(awemeId, videoId);
      if (registrations.size > 2000) {
        for (const [id, entry] of registrations) if (entry.until <= Date.now()) registrations.delete(id);
        if (registrations.size > 2000) registrations.delete(registrations.keys().next().value);
      }
      registrations.set(awemeId, { videoId, until: Date.now() + REGISTRATION_TTL });
      send(200, { mediaUrl: new URL(`/media/douyin/${awemeId}/audio.mp4`, base).href });
      return true;
    }
    const stable = /^\/media\/douyin\/(\d{16,22})\/audio\.mp4$/.exec(url.pathname);
    if (!stable || !['GET', 'HEAD'].includes(req.method)) return false;
    const awemeId = stable[1];
    const registration = registrations.get(awemeId);
    if (!registration || registration.until <= Date.now()) fail(404, 'Douyin video not registered; open it in the helper again');
    const key = `${awemeId}:${registration.videoId}`;
    let job = resolveJobs.get(key);
    if (!job) {
      const pageUrl = new URL(`https://www.douyin.com/video/${awemeId}`);
      job = this.resolve(pageUrl, { fetcher, signal: AbortSignal.timeout(20000), videoId: registration.videoId })
        .then(async source => {
          for (const candidate of source.upstreams) await assertPublicUrl(candidate, effectiveAllowedHosts);
          return { ...source, videoUrl: pageUrl.href, quality: 'best', mode: 'stream' };
        });
      resolveJobs.set(key, job);
      job.finally(() => { if (resolveJobs.get(key) === job) resolveJobs.delete(key); }).catch(() => {});
    }
    const source = await job;
    await parallelAudio(req, res, source, {
      fetcher: mediaFetcher, allowedHosts: effectiveAllowedHosts, maxBytes,
      threads: parallelThreads, chunkBytes: parallelChunkBytes, fallbackToStream: true, retries: 4, onBytes: () => {}
    });
    return true;
  },

  mediaTranslationPriority: 10,
  async prepareMediaTranslation(body, { publicBaseUrl }) {
    let signed;
    try { signed = signedProxyMediaUrlFromEnvelope(body); }
    catch { return null; } // Not a recognized Douyin VOT envelope.
    if (!signed) return null;
    let candidate, base;
    try { candidate = new URL(signed); base = new URL(publicBaseUrl); } catch { return null; }
    if (candidate.origin !== base.origin ||
        !/^\/media\/douyin\/\d{16,22}\/audio\.mp4$/.test(candidate.pathname) ||
        candidate.search || candidate.hash || candidate.username || candidate.password) return null;
    return { body, mediaUrl: candidate.href };
  },

  matches(u) { return ['www.douyin.com', 'douyin.com'].includes(u.hostname.toLowerCase()) && /\/video\/\d{16,22}/.test(u.pathname); },
  async resolve(u, { fetcher = fetch, signal, videoId } = {}) {
    // The public aweme ID and internal playback video ID are different identifiers.
    // Only accept an internal ID resolved by the browser helper; never fetch user-provided URLs.
    const awemeId = /\/video\/(\d{16,22})/.exec(u.pathname)?.[1];
    validateDouyinIds(awemeId, videoId);
    const endpoint = new URL('https://www.douyin.com/aweme/v1/playwm/');
    endpoint.search = new URLSearchParams({ line: '0', logo_name: 'aweme_diversion_search', ratio: '720p', video_id: videoId }).toString();
    const response = await fetcher(endpoint, { headers: { ...HEADERS, Range: 'bytes=0-1' }, signal, redirect: 'manual' });
    const destination = response.headers.get('location');
    // Do not accept HTML/challenge responses as video media.
    if (![301, 302, 303, 307, 308].includes(response.status) || !destination) fail(502, `Douyin playwm redirect unavailable (HTTP ${response.status})`);
    const target = new URL(destination, endpoint);
    if (target.protocol !== 'https:') fail(502, 'Douyin returned non-HTTPS media URL');
    console.log('[DOUYIN CDN HOST]', target.hostname);
    return {
      site: 'douyin', id: awemeId, contentType: 'video/mp4',
      upstreams: [target.href], headers: HEADERS,
      metadata: { awemeId, videoId }
    };
  }
};
