import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdapters, registry } from '../src/core/adapter-loader.js';

test('built-in adapters are discovered automatically', () => {
  assert.deepEqual(registry.adapters.map(a => a.id).sort(), ['bilibili', 'douyin']);
});
test('adding one adapter file makes it discoverable; backups are ignored', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'adapter-test-'));
  try {
    await writeFile(join(directory, 'sample.js'), "export default {id:'sample',matches:u=>u.hostname==='sample.example',async resolve(){return {site:'sample',id:'1',contentType:'audio/mp4',upstreams:['https://cdn.sample.example/a.mp4'],headers:{}}}};");
    await writeFile(join(directory, 'ignored.js.bak'), 'invalid javascript');
    const found = await loadAdapters({ directory });
    assert.equal(found.find(new URL('https://sample.example/video')).id, 'sample');
    assert.equal(found.adapters.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('invalid plugins fail startup instead of silently disappearing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'adapter-invalid-'));
  try {
    await writeFile(join(directory, 'broken.js'), 'export default {id:"broken"};');
    await assert.rejects(loadAdapters({ directory }), /Invalid adapter broken.js/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
