import { signedProxyMediaUrlFromEnvelope } from '../core/vot-protobuf.js';
import { fail } from '../core/errors.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://www.douyin.com/',
  Accept: '*/*'
};

const AWEME = /^\d{16,22}$/;
const VIDEO = /^v[a-zA-Z0-9_-]{10,}$/;
const REGISTRATION_TTL = 24 * 60 * 60 * 1000;
const RESOLVE_TIMEOUT_MS = 20_000;
// Retry policy is centralized in parallelAudio/proxyAudio, not duplicated here.
const MAX_CDN_THREADS_PER_VIDEO = 2;
const MAX_REGISTRATIONS = 2000;
const MEDIA_HOSTS = [
  'douyinvod.com', 'douyin.com', 'bytecdn.cn',
  'byteimg.com', 'douyincdn.com', 'zjcdn.com'
];

const registrations = new Map();
const resolveJobs = new Map();

export function validateDouyinIds(awemeId, videoId) {
  if (!AWEME.test(String(awemeId || '')) || !VIDEO.test(String(videoId || ''))) {
    fail(400, 'Invalid Douyin identifiers');
  }
}

function isAllowedMediaHost(hostname) {
  const name = hostname.toLowerCase();
  return MEDIA_HOSTS.some(host => name === host || name.endsWith(`.${host}`));
}

function isClientGone(req, res) {
  return req.aborted || res.destroyed || res.writableEnded;
}

function cleanupRegistrations() {
  const now = Date.now();
  for (const [id, entry] of registrations) {
    if (entry.until <= now) registrations.delete(id);
  }
  while (registrations.size >= MAX_REGISTRATIONS) {
    registrations.delete(registrations.keys().next().value);
  }
}

async function validateSource(source, assertPublicUrl, effectiveAllowedHosts) {
  if (!Array.isArray(source?.upstreams) || !source.upstreams.length) {
    fail(502, 'Douyin returned no CDN URLs');
  }
  for (const candidate of source.upstreams) {
    let target;
    try { target = new URL(candidate); }
    catch { fail(502, 'Douyin returned an invalid CDN URL'); }
    if (target.protocol !== 'https:' || !isAllowedMediaHost(target.hostname)) {
      fail(502, 'Douyin returned an untrusted CDN URL');
    }
    // Keep public-IP / DNS-rebinding checks from the proxy's security layer.
    await assertPublicUrl(candidate, effectiveAllowedHosts);
  }
  return source;
}

export const douyin = {
  id: 'douyin',
  mediaHosts: MEDIA_HOSTS,

  async handleRequest({
    req, res, url, base, send, fetcher, mediaFetcher,
    effectiveAllowedHosts, maxBytes, parallelThreads, parallelChunkBytes,
    assertPublicUrl, parallelAudio
  }) {
    if (url.pathname === '/api/douyin/register' && req.method === 'POST') {
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

      const awemeId = String(data?.awemeId || '');
      const videoId = String(data?.videoId || '');
      validateDouyinIds(awemeId, videoId);
      cleanupRegistrations();
      registrations.set(awemeId, { videoId, until: Date.now() + REGISTRATION_TTL });
      send(200, {
        mediaUrl: new URL(`/media/douyin/${awemeId}/audio.mp4`, base).href
      });
      return true;
    }

    const match = /^\/media\/douyin\/(\d{16,22})\/audio\.mp4$/.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(req.method)) return false;

    const awemeId = match[1];
    const registration = registrations.get(awemeId);
    if (!registration || registration.until <= Date.now()) {
      registrations.delete(awemeId);
      fail(404, 'Douyin video not registered; open it in the helper again');
    }

    // Snapshot registration so a concurrent registration cannot change this request.
    const videoId = registration.videoId;
    const key = `${awemeId}:${videoId}`;
    const pageUrl = new URL(`https://www.douyin.com/video/${awemeId}`);

    const resolveFresh = async () => {
      const source = await this.resolve(pageUrl, {
        fetcher,
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        videoId
      });
      await validateSource(source, assertPublicUrl, effectiveAllowedHosts);
      return {
        ...source,
        videoUrl: pageUrl.href,
        quality: 'best',
        mode: 'stream'
      };
    };

    let job = resolveJobs.get(key);
    if (!job) {
      job = resolveFresh();
      resolveJobs.set(key, job);
      // Clear both successful and rejected jobs. Never cache a rejected promise.
      job.finally(() => {
        if (resolveJobs.get(key) === job) resolveJobs.delete(key);
      }).catch(() => {});
    }

    let source = await job;
    if (isClientGone(req, res)) return true;

    // Different videos run concurrently. Limit only CDN fan-out *per video*.
    // Do not nest adapter retries around parallelAudio's retries and stream fallback:
    // the old nested loops could keep a single VOT request open for minutes.
    await parallelAudio(req, res, source, {
      fetcher: mediaFetcher,
      allowedHosts: effectiveAllowedHosts,
      maxBytes,
      threads: Math.min(MAX_CDN_THREADS_PER_VIDEO, Math.max(1, Number(parallelThreads) || 1)),
      chunkBytes: parallelChunkBytes,
      fallbackToStream: true,
      retries: 1,
      // No refreshSource: playwm may redirect to the same failing CDN host.
      // An alternative CDN must be a genuinely supplied, validated URL.
      onBytes: () => {}
    });
    return true;
  },

  mediaTranslationPriority: 10,

  async prepareMediaTranslation(body, { publicBaseUrl }) {
    let signed;
    try { signed = signedProxyMediaUrlFromEnvelope(body); }
    catch { return null; }
    if (!signed) return null;
    let candidate, base;
    try {
      candidate = new URL(signed);
      base = new URL(publicBaseUrl);
    } catch { return null; }
    if (candidate.origin !== base.origin ||
        !/^\/media\/douyin\/\d{16,22}\/audio\.mp4$/.test(candidate.pathname) ||
        candidate.search || candidate.hash || candidate.username || candidate.password) {
      return null;
    }
    return { body, mediaUrl: candidate.href };
  },

  matches(u) {
    return ['www.douyin.com', 'douyin.com'].includes(u.hostname.toLowerCase()) &&
      /\/video\/\d{16,22}/.test(u.pathname);
  },

  async resolve(u, { fetcher = fetch, signal, videoId } = {}) {
    const awemeId = /\/video\/(\d{16,22})/.exec(u.pathname)?.[1];
    validateDouyinIds(awemeId, videoId);

    const endpoint = new URL('https://www.douyin.com/aweme/v1/playwm/');
    endpoint.search = new URLSearchParams({
      line: '0',
      logo_name: 'aweme_diversion_search',
      ratio: '720p',
      video_id: videoId
    }).toString();

    const response = await fetcher(endpoint, {
      headers: { ...HEADERS, Range: 'bytes=0-1' },
      signal,
      redirect: 'manual'
    });
    const destination = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !destination) {
      fail(502, `Douyin playwm redirect unavailable (HTTP ${response.status})`);
    }
    const target = new URL(destination, endpoint);
    if (target.protocol !== 'https:' || !isAllowedMediaHost(target.hostname)) {
      fail(502, 'Douyin returned an untrusted media URL');
    }
    console.log('[DOUYIN CDN HOST]', target.hostname);
    return {
      site: 'douyin',
      id: awemeId,
      contentType: 'video/mp4',
      upstreams: [target.href],
      headers: HEADERS,
      metadata: { awemeId, videoId }
    };
  }
};
