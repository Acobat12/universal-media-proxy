import https from 'node:https';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { privateAddress } from './security.js';

// Resolve once, then pin the validated IP to the TLS socket. No automatic redirects.
export async function pinnedFetch(url, { method = 'GET', headers = {}, signal, connectTimeoutMs = 15000 } = {}) {
  const host = url.hostname;
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw Error('Unsafe DNS answer');
  const selected = addresses[0];
  if (host === 'v3-dy-o.zjcdn.com') {
    console.log('[DOUYIN CDN IP]', selected.address);
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const request = https.request(url, {
      method, headers, agent: false, signal, timeout: connectTimeoutMs,
      lookup: (_hostname, options, cb) => {
        if (options?.all) {
          cb(null, [{ address: selected.address, family: selected.family }]);
        } else {
          cb(null, selected.address, selected.family);
        }
      },
      maxHeaderSize: 16384
    }, response => {
      settled = true;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value != null) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve({ status: response.statusCode, headers: responseHeaders,
        body: method === 'HEAD' ? null : Readable.toWeb(response),
        cancel: () => response.destroy() });
    });
    request.on('timeout', () => request.destroy(Error('Connection timeout')));
    request.on('error', error => { if (!settled) reject(error); });
    request.end();
  });
}
