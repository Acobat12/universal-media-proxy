import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteBilibiliUrls } from '../src/media-translation.js';
const field = b => Buffer.concat([Buffer.from([0x0a,b.length]), b]);
test('rewrites nested protobuf Bilibili URL while preserving other fields', () => {
 const original = 'https://www.bilibili.com/video/BV18b411q7Fb/';
 const input = Buffer.concat([Buffer.from([0x10,0x07]),field(field(Buffer.from(original)))]);
 const result = rewriteBilibiliUrls(input,'https://proxy.example/media/token');
 assert.deepEqual(result.urls,[original]);
 assert.equal(result.bytes[0],0x10);
 assert.equal(result.bytes[1],0x07);
 assert.match(result.bytes.toString(),/https:\/\/proxy.example\/media\/token/);
 assert.doesNotMatch(result.bytes.toString(),/bilibili\.com/);
});
test('leaves unrelated protobuf payload unchanged', () => {
 const input = field(Buffer.from('hello'));
 assert.deepEqual(rewriteBilibiliUrls(input,'https://proxy.example/media').bytes,input);
});
import { rewriteEnvelopeMedia } from '../src/media-translation.js';
const f = (tag, data) => Buffer.concat([Buffer.from([tag, data.length]), data]);
test('VOT envelope rewrite preserves headers and path while rewriting inner URL', () => {
 const url = 'https://www.bilibili.com/video/BV18b411q7Fb/';
 const payload = f(10, Buffer.from(url));
 const envelope = Buffer.concat([f(10, f(10, Buffer.from('x'))), f(18, payload), f(26, Buffer.from('/video-translation/translate'))]);
 const result = rewriteEnvelopeMedia(envelope, 'https://media.example/media/token');
 assert.deepEqual(result.urls, [url]);
 assert.match(result.bytes.toString(), /media.example\/media\/token/);
 assert.match(result.bytes.toString(), /video-translation\/translate/);
 assert.doesNotMatch(result.bytes.toString(), /bilibili.com/);
});

test('VOT envelope carries Bilibili source metadata independently of signed body', () => {
 const url = 'https://www.bilibili.com/video/BV18b411q7Fb/';
 const envelope = Buffer.concat([f(18, f(10, Buffer.from('opaque'))), f(26, Buffer.from('/video-translation/translate')), f(34, Buffer.from(url))]);
 const result = rewriteEnvelopeMedia(envelope, 'https://media.example/media/token');
 assert.equal(result.sourceVideoUrl, url);
 assert.deepEqual(result.urls, []);
 assert.deepEqual(result.bytes, envelope);
});
