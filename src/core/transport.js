import https from 'node:https';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { privateAddress } from './security.js';

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Request aborted');
}

// Bounds the wait for DNS. Node's underlying DNS lookup cannot always be cancelled,
// but its eventual result cannot reopen an HTTP request after this promise rejects.
async function resolveAddresses(host, signal, timeoutMs) {
  if (signal?.aborted) throw abortError(signal);
  let timer;
  let onAbort;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timeout')), timeoutMs);
  });
  const aborted = new Promise((_, reject) => {
    if (signal) {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([lookup(host, { all: true }), timeout, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// Resolve once, validate the complete DNS answer, then pin the selected public IP.
export async function pinnedFetch(url, {
  method = 'GET', headers = {}, signal, connectTimeoutMs = 15000
} = {}) {
  const target = url instanceof URL ? url : new URL(url);
  if (target.protocol !== 'https:') throw new Error('HTTPS upstream required');
  const addresses = await resolveAddresses(target.hostname, signal, connectTimeoutMs);
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) {
    throw new Error('Unsafe DNS answer');
  }
  if (signal?.aborted) throw abortError(signal);
  const selected = addresses[0];

  return await new Promise((resolve, reject) => {
    let settled = false;
    let responseStream;
    const request = https.request(target, {
      method, headers, agent: false, signal, timeout: connectTimeoutMs,
      lookup: (_hostname, options, cb) => {
        if (options?.all) cb(null, [{ address: selected.address, family: selected.family }]);
        else cb(null, selected.address, selected.family);
      },
      maxHeaderSize: 16384
    }, response => {
      responseStream = response;
      settled = true;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value != null) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      if (method === 'HEAD') response.resume();
      resolve({
        status: response.statusCode,
        headers: responseHeaders,
        body: method === 'HEAD' ? null : Readable.toWeb(response),
        cancel: () => response.destroy()
      });
    });
    request.on('timeout', () => request.destroy(new Error('Connection timeout')));
    request.on('error', error => {
      // After headers are received, the response stream must see network errors.
      if (settled) responseStream?.destroy(error);
      else reject(error);
    });
    request.end();
  });
}
