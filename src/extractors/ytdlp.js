import { spawn } from 'node:child_process';
import { fail } from '../core/errors.js';

// Metadata-only extraction. Never pass user input through a shell or download media.
export async function resolveYtDlp(url, { binary = 'yt-dlp', timeoutMs = 20000, maxOutputBytes = 4 * 1024 * 1024, spawnProcess = spawn, signal, quality = 'best' } = {}) {
  if (!(url instanceof URL) || url.protocol !== 'https:' || url.username || url.password) fail(400, 'Invalid source URL');
  const args = ['--no-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', '--no-call-home', '--socket-timeout', '10', '--', url.href];
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let output = ''; let error = ''; let finished = false;
    const finish = (err, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (err) reject(err); else resolve(value); };
    const abort = () => child.kill('SIGKILL');
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > maxOutputBytes) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-2048); });
    child.on('error', e => finish(Error(`yt-dlp failed to launch: ${e.message}`)));
    child.on('close', code => {
      if (code !== 0) return finish(Error(`yt-dlp failed (exit ${code}): ${error.slice(-200)}`));
      try {
        const info = JSON.parse(output);
        const tracks = (info.formats || []).filter(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && /^https:\/\//i.test(f.url));
        if (!tracks.length && info.url && info.acodec !== 'none' && (!info.vcodec || info.vcodec === 'none') && /^https:\/\//i.test(info.url)) tracks.push(info);
        if (!tracks.length) return finish(Error('yt-dlp found no direct audio-only HTTPS streams'));
        tracks.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
        const selected = quality === 'lowest' ? tracks.at(-1) : quality === 'medium' ? tracks[Math.floor((tracks.length - 1) / 2)] : tracks[0];
        const headers = {};
        for (const [k,v] of Object.entries(info.http_headers || selected.http_headers || {})) {
          if (/^(user-agent|referer|origin)$/i.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v;
        }
        finish(null, { site: 'yt-dlp', id: String(info.id || ''), contentType: selected.ext === 'webm' ? 'audio/webm' : 'audio/mp4', upstreams: [selected.url], headers, metadata: { extractor: 'yt-dlp', title: String(info.title || '').slice(0, 150), format: selected.format_id } });
      } catch (e) { finish(e); }
    });
  });
}
