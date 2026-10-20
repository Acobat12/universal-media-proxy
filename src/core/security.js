import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fail } from './errors.js';

export function safeHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (isIP(h)) return !privateAddress(h);
  return h.includes('.');
}
export function privateAddress(ip) {
  if (ip.includes(':')) {
    const s = ip.toLowerCase();
    if (s.startsWith('::ffff:')) return privateAddress(s.slice(7));
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s) || s.startsWith('2001:db8:');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 192 && p[1] === 0 && p[2] === 0) || (p[0] === 198 && (p[1] === 18 || p[1] === 19));
}
export async function assertPublicUrl(input, allowedHosts) {
  let u; try { u = new URL(input); } catch { fail(400, 'Invalid upstream URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443') fail(400, 'HTTPS upstream required');
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!safeHostname(h)) fail(400, 'Unsafe upstream hostname');
  if (!allowedHosts.some(x => h === x || h.endsWith('.' + x))) fail(403, 'Upstream hostname not allowed');
  const addresses = await lookup(h, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) fail(403, 'Private upstream address');
  return u;
}
export function validRange(range) {
  if (range == null) return null;
  if (range.length > 120 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) fail(416, 'Unsupported Range');
  return range;
}
