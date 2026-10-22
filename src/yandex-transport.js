// Optional alternative outbound transports for Yandex. Default retains the original fetch.
import http2 from 'node:http2';
import { spawn } from 'node:child_process';

const mode = () => (process.env.VOT_YANDEX_TRANSPORT || 'node').toLowerCase();
const timeout = () => Math.max(1000, Number(process.env.VOT_YANDEX_TIMEOUT_MS) || 15000);

function safeHeaderEntries(headers) {
  const result = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (['host', 'connection', 'transfer-encoding', 'content-length', 'keep-alive', 'upgrade', 'proxy-connection'].includes(key)) continue;
    result[key] = value;
  }
  return result;
}

async function viaHttp2(request) {
  const url = new URL(request.url);
  const bytes = request.body ? Buffer.from(await request.arrayBuffer()) : null;
  const client = http2.connect(url.origin, { settings: { enablePush: false } });
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.close();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => { client.destroy(); finish(new Error('HTTP/2 upstream timeout')); }, timeout());
    client.once('error', err => finish(err));
    client.once('connect', () => {
      if (client.alpnProtocol !== 'h2') {
        finish(new Error(`Upstream did not negotiate HTTP/2: ${client.alpnProtocol || 'none'}`));
        return;
      }
      const stream = client.request({ ':method': request.method, ':path': url.pathname + url.search, ':authority': url.host, ':scheme': url.protocol.slice(0, -1), ...safeHeaderEntries(request.headers) });
      const chunks = [];
      let responseHeaders;
      stream.on('response', h => { responseHeaders = h; });
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', err => finish(err));
      stream.on('end', () => {
        if (!responseHeaders) return finish(new Error('Missing HTTP/2 response headers'));
        const headers = new Headers();
        for (const [key, value] of Object.entries(responseHeaders)) {
          if (key.startsWith(':') || value == null) continue;
          if (Array.isArray(value)) for (const v of value) headers.append(key, v);
          else headers.set(key, String(value));
        }
        finish(null, new Response(Buffer.concat(chunks), { status: Number(responseHeaders[':status']), headers }));
      });
      stream.end(bytes || undefined);
    });
  });
}

async function viaCurl(request) {
  const bytes = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
  const args = ['--silent', '--show-error', '--http2', '--max-time', String(Math.ceil(timeout() / 1000)), '--request', request.method, '--dump-header', '-', '--output', '-', '--url', request.url];
  for (const [key, value] of Object.entries(safeHeaderEntries(request.headers))) args.push('--header', `${key}: ${value}`);
  if (bytes.length) args.push('--data-binary', '@-');
  return await new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', x => out.push(x));
    child.stderr.on('data', x => { if (Buffer.concat(err).length < 2048) err.push(x); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`curl exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 250)}`));
      const all = Buffer.concat(out);
      // curl may print interim 1xx header blocks; select the last complete header block.
      let offset = 0, block = null;
      while (all.subarray(offset, offset + 5).toString() === 'HTTP/') {
        const end = all.indexOf('\r\n\r\n', offset);
        if (end < 0) return reject(new Error('Malformed curl response headers'));
        block = all.subarray(offset, end).toString('latin1');
        offset = end + 4;
      }
      if (!block) return reject(new Error('No HTTP response headers from curl'));
      const lines = block.split('\r\n');
      const status = Number(lines.shift().match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
      const headers = new Headers();
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx > 0) headers.append(line.slice(0, idx), line.slice(idx + 1).trim());
      }
      resolve(new Response(all.subarray(offset), { status, headers }));
    });
    child.stdin.end(bytes);
  });
}

export async function yandexFetch(request) {
  const selected = mode();
  const start = performance.now();
  try {
    const response = selected === 'node' ? await fetch(request)
      : selected === 'http2' ? await viaHttp2(request)
      : selected === 'curl' ? await viaCurl(request)
      : (() => { throw new Error(`Unsupported VOT_YANDEX_TRANSPORT: ${selected}`); })();
    if (process.env.VOT_DIAGNOSTICS !== 'false') console.log('[VOT TRANSPORT]', JSON.stringify({ mode: selected, status: response.status, elapsedMs: Math.round(performance.now() - start), path: new URL(request.url).pathname }));
    return response;
  } catch (error) {
    console.error('[VOT TRANSPORT ERROR]', JSON.stringify({ mode: selected, path: new URL(request.url).pathname, error: String(error) }));
    throw error;
  }
}
