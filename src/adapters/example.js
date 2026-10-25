// Документационный пример: src/adapters/newsite.js
// Замените домены, URL страниц и getRealMediaUrl() данными реального сайта.
// Пока getRealMediaUrl() не реализован, адаптер намеренно НЕ работает.

import { fail } from '../core/errors.js';

const SITE_HOST = 'www.newsite.example';
const CDN_HOST = 'cdn.newsite.example';
const VIDEO_PATH = /^\/watch\/([A-Za-z0-9_-]{1,64})$/;
const MEDIA_PATH = /^\/media\/newsite\/([A-Za-z0-9_-]{1,64})\/audio\.mp4$/;

function getId(url) {
  if (url.protocol !== 'https:' || url.hostname !== SITE_HOST || url.username || url.password) return null;
  return VIDEO_PATH.exec(url.pathname)?.[1] ?? null;
}

async function getRealMediaUrl(id, { fetcher, signal }) {
  // TODO: вызовите официальный или разрешённый API конкретного сайта,
  // проверьте ответ и извлеките действительный HTTPS CDN URL.
  // Не используйте фиктивный URL и не принимайте upstream от клиента.
  void id; void fetcher; void signal;
  fail(501, 'Implement CDN resolution for this site');
}

export default {
  id: 'newsite',
  mediaHosts: [CDN_HOST],
  matches(url) { return Boolean(getId(url)); },
  async resolve(url, { fetcher = fetch, signal, quality = 'best' } = {}) {
    const id = getId(url);
    if (!id) fail(400, 'Invalid Newsite video URL');
    const mediaUrl = new URL(await getRealMediaUrl(id, { fetcher, signal, quality }));
    if (mediaUrl.protocol !== 'https:' || mediaUrl.hostname !== CDN_HOST || mediaUrl.username || mediaUrl.password) {
      fail(422, 'Untrusted media URL');
    }
    return {
      site: 'newsite', id, contentType: 'audio/mp4',
      upstreams: [mediaUrl.href], headers: {}, metadata: { quality }
    };
  },
  stableMediaPath(url) {
    const id = getId(url);
    if (!id) fail(400, 'Invalid Newsite video URL');
    return `/media/newsite/${id}/audio.mp4`;
  },
  async resolveMediaPath(path, context) {
    const id = MEDIA_PATH.exec(path)?.[1];
    if (!id) fail(404, 'Invalid Newsite media path');
    return this.resolve(new URL(`https://${SITE_HOST}/watch/${id}`), context);
  }
  // Для VOT отдельно реализуйте prepareMediaTranslation(body, context).
  // Для регистрации отдельно реализуйте handleRequest(context).
};
