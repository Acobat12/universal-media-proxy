import { fail } from '../core/errors.js';
const SITE = ['www.bilibili.com', 'bilibili.com'];
const API = 'https://api.bilibili.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
function videoId(u) { return u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/)?.[1]; }
async function json(url, fetcher, signal) {
  const r = await fetcher(url, { headers: HEADERS, signal, redirect: 'manual' });
  if (!r.ok) fail(502, `Bilibili API HTTP ${r.status}`);
  const body = await r.json();
  if (body.code !== 0) fail(502, `Bilibili API error ${body.code}: ${String(body.message).slice(0, 120)}`);
  return body.data;
}
export const bilibili = {
  id: 'bilibili',
  matches(u) { return SITE.includes(u.hostname.toLowerCase()) && !!videoId(u); },
  async resolve(u, { fetcher = fetch, signal, quality = 'best' } = {}) {
    const bvid = videoId(u);
    const p = Number(u.searchParams.get('p') || '1');
    if (!Number.isSafeInteger(p) || p < 1 || p > 1000) fail(400, 'Invalid page number');
    if (!['best','medium','lowest'].includes(quality)) fail(400, 'Invalid audio quality');
    const view = await json(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, fetcher, signal);
    const cid = view.pages?.[p - 1]?.cid;
    if (!Number.isSafeInteger(cid) || cid <= 0) fail(404, 'Video part not found');
    // WBI endpoint: may require signing or account access for some videos.
    const play = await json(`${API}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16`, fetcher, signal);
    const tracks = (play.dash?.audio || []).filter(a => a.baseUrl || a.base_url).sort((a,b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (!tracks.length) fail(422, 'No DASH audio track (region/login/WBI may be required)');
    const index = quality === 'lowest' ? tracks.length - 1 : quality === 'medium' ? Math.floor((tracks.length - 1) / 2) : 0;
    const audio = tracks[index];
    const urls = [audio.baseUrl || audio.base_url, ...(audio.backupUrl || audio.backup_url || [])];
    return { site: 'bilibili', id: `${bvid}-p${p}`, contentType: audio.mimeType || 'audio/mp4', upstreams: [...new Set(urls)], headers: HEADERS, metadata: { bvid, cid, page: p, quality, bandwidth: audio.bandwidth || null } };
  }
};
