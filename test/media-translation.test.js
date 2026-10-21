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
