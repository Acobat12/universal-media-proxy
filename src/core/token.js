import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.js';
const b64 = x => Buffer.from(x).toString('base64url');
export function sign(payload, secret) {
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verify(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 16000) fail(401, 'Invalid token');
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) fail(401, 'Invalid token');
  const expected = createHmac('sha256', secret).update(body).digest();
  let provided; try { provided = Buffer.from(sig, 'base64url'); } catch { fail(401, 'Invalid token'); }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) fail(401, 'Invalid token');
  let data; try { data = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { fail(401, 'Invalid token'); }
  if (!Number.isSafeInteger(data.exp) || data.exp < now || !Array.isArray(data.upstreams) || !data.upstreams.length || data.upstreams.length > 8) fail(401, 'Expired or invalid token');
  return data;
}
