import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/core/registry.js';
import { bilibili } from '../src/adapters/bilibili.js';
import { privateAddress, safeHostname, validRange } from '../src/core/security.js';

const secret = 'a'.repeat(48);
test('registry matches Bilibili and rejects unknown sites', () => {
  const r = new Registry().register(bilibili);
  assert.equal(r.find(new URL('https://www.bilibili.com/video/BV1xx411c7mD')).id, 'bilibili');
  assert.throws(() => r.find(new URL('https://example.org/video')));
});
test('Bilibili resolves best audio and fallback CDN', async () => {
  const fetcher = async url => ({ ok: true, json: async () => url.includes('/pagelist?') ? { code: 0, data: { pages: [{ cid: 42 }] } } : { code: 0, data: { dash: { audio: [{ bandwidth: 80, baseUrl: 'https://a.bilivideo.com/a.m4s', backupUrl: ['https://b.bilivideo.com/a.m4s'] }, { bandwidth: 40, baseUrl: 'https://c.bilivideo.com/a.m4s' }] } } } });
  const s = await bilibili.resolve(new URL('https://www.bilibili.com/video/BV1xx411c7mD?p=1'), { fetcher });
  assert.equal(s.metadata.cid, 42); assert.equal(s.upstreams.length, 2); assert.equal(s.upstreams[0], 'https://a.bilivideo.com/a.m4s');
});
test('private network guard and ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.20.1.2', '192.168.0.2', '169.254.1.1', '::1', 'fd00::1']) assert.equal(privateAddress(ip), true);
  assert.equal(privateAddress('8.8.8.8'), false);
  assert.equal(safeHostname('localhost'), false);
  assert.equal(validRange('bytes=0-99'), 'bytes=0-99');
  assert.throws(() => validRange('bytes=0-1,3-4'));
});
