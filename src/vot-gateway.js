import { Readable } from 'node:stream';
import worker from './vot-worker.js';

const records = new Map();
const meta = {
  async put(key, value, options = {}) { records.set(key, { value, expires: Date.now() + Math.min(60, Math.max(1, Number(options.expirationTtl || 60))) * 1000 }); },
  async get(key) { const item = records.get(key); if (!item) return null; if (item.expires <= Date.now()) { records.delete(key); return null; } return item.value; },
};
const allowedPaths = ['/vot/metadata', '/video-translation/', '/video-subtitles/', '/stream-translation/', '/session/create'];
export function createVotGateway({ yandexApiUrl, serverId, maxBodyBytes = 1048576 } = {}) {
  const env = { YANDEX_API_URL: yandexApiUrl, SERVER_ID: serverId, VOT_META_KV: meta };
  return async (req, res) => {
    try {
      const incoming = new URL(req.url || '/', 'http://localhost');
      const path = incoming.pathname === '/vot/metadata'
        ? '/vot/metadata'
        : incoming.pathname.startsWith('/vot/') ? incoming.pathname.slice('/vot'.length) : incoming.pathname;
      if (!allowedPaths.some(p => path === p || (p.endsWith('/') && path.startsWith(p)))) { res.writeHead(404); return res.end(); }
      if (process.env.VOT_DIAGNOSTICS !== "false") console.log("[VOT ROUTE]", JSON.stringify({originalPath: incoming.pathname, gatewayPath: path, mode: incoming.pathname.startsWith("/vot/") ? "direct-vot" : "root-or-media", method: req.method}));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value != null && !['host','connection','transfer-encoding','content-length'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const hasBody = !['GET','HEAD'].includes(req.method);
      let body;
      if (hasBody) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > maxBodyBytes) { res.writeHead(413); return res.end('Payload too large'); } chunks.push(chunk); }
        body = Buffer.concat(chunks);
      }
      incoming.pathname = path;
      const request = new Request(incoming, { method: req.method, headers, ...(hasBody ? { body } : {}) });
      const response = await worker.fetch(request, env);
      res.statusCode = response.status;
      for (const [name, value] of response.headers) if (!['connection','transfer-encoding','content-length'].includes(name)) res.setHeader(name, value);
      if (req.method === 'HEAD' || !response.body) return res.end();
      const stream = Readable.fromWeb(response.body);
      stream.on('error', error => res.destroy(error));
      stream.pipe(res);
    } catch (error) {
      console.error('[VOT gateway]', error);
      if (res.headersSent) res.destroy(error);
      else { res.writeHead(502); res.end('VOT upstream error'); }
    }
  };
}
