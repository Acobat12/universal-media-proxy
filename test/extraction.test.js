import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAudio } from '../src/core/extraction.js';
import { Registry } from '../src/core/registry.js';
import { resolveYtDlp } from '../src/extractors/ytdlp.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('native adapter is preferred and yt-dlp is not called', async () => {
 const registry = new Registry().register({ id: 'example', matches: () => true, resolve: async () => ({site:'example',upstreams:['https://example.com/a']}) });
 const result = await extractAudio(new URL('https://example.com/v'), { registry, fallbackEnabled: true, ytdlp: () => { throw Error('should not run'); } });
 assert.equal(result.site, 'example');
});
test('unsupported host cannot trigger fallback', async () => {
 let called = false;
 await assert.rejects(extractAudio(new URL('https://example.com/v'), { registry: new Registry(), fallbackEnabled: true, fallbackHosts: ['youtube.com'], ytdlp: () => { called = true; } }), /Unsupported site/);
 assert.equal(called, false);
});
test('yt-dlp metadata only, no shell, audio-only format', async () => {
 let seen;
 function fakeSpawn(binary,args,opts) {
  seen = {binary,args,opts};
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  queueMicrotask(() => { child.stdout.write(JSON.stringify({id:'abc',formats:[{url:'https://cdn.example/a',acodec:'mp4a.40.2',vcodec:'none',abr:128,ext:'m4a'},{url:'https://cdn.example/v',acodec:'aac',vcodec:'h264',abr:500}]})); child.stdout.end(); child.emit('close',0); });
  return child;
 }
 const source = await resolveYtDlp(new URL('https://youtube.com/watch?v=abc'), { spawnProcess: fakeSpawn });
 assert.equal(source.upstreams[0], 'https://cdn.example/a');
 assert.equal(seen.opts.shell, false);
 assert.ok(seen.args.includes('--skip-download'));
 assert.equal(seen.args.at(-1), 'https://youtube.com/watch?v=abc');
});
