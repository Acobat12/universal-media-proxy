import test from 'node:test';
import assert from 'node:assert/strict';
import { bilibili } from '../src/adapters/bilibili.js';
import { createHandler } from '../src/server.js';
import { Readable } from 'node:stream';

test('Bilibili stable media path is deterministic and has no token', () => {
  const u = new URL('https://www.bilibili.com/video/BV18b411q7Fb?p=2');
  assert.equal(bilibili.stableMediaPath(u), '/media/bilibili/BV18b411q7Fb/p2/audio.m4a');
  assert.equal(bilibili.stableMediaPath(u), bilibili.stableMediaPath(u));
});

test('resolve API returns stable path without signed token or expiration', async () => {
  const handler = createHandler({ publicBaseUrl: 'https://proxy.example.com' });
  const req = Readable.from([Buffer.from(JSON.stringify({ url: 'https://www.bilibili.com/video/BV18b411q7Fb?p=2' }))]);
  req.url = '/api/resolve'; req.method = 'POST';
  const res = { writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(data); } };
  await handler(req, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.mediaUrl, 'https://proxy.example.com/media/bilibili/BV18b411q7Fb/p2/audio.m4a');
  assert.equal('expiresAt' in res.body, false);
});
