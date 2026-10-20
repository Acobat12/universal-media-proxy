import { fail } from './errors.js';
import { assertPublicUrl } from './security.js';
import { resolveYtDlp } from '../extractors/ytdlp.js';

// Explicit allowlist prevents arbitrary URL extraction / SSRF from the fallback process.
export async function extractAudio(url, { registry, fetcher = fetch, quality = 'best', signal, fallbackEnabled = false, fallbackHosts = [], ytdlp = resolveYtDlp } = {}) {
  const adapter = registry.adapters.find(a => a.matches(url));
  let firstError;
  if (adapter) {
    try { return await adapter.resolve(url, { fetcher, quality, signal }); }
    catch (e) { firstError = e; }
  }
  const host = url.hostname.toLowerCase();
  if (fallbackEnabled && fallbackHosts.some(h => host === h || host.endsWith('.' + h))) {
    try { await assertPublicUrl(url.href, fallbackHosts); return await ytdlp(url, { signal, quality }); }
    catch (e) { if (!firstError) firstError = e; }
  }
  if (firstError) throw firstError;
  fail(422, 'Unsupported site or yt-dlp fallback disabled');
}
