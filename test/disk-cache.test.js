import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskCache } from '../src/core/disk-cache.js';

test('SSD cache stores file, reuses it, and removes it after TTL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ump-disk-test-'));
  const cache = createDiskCache({ directory: dir, ttlMs: 35, sweepMs: 10000, maxBytes: 100, maxFileBytes: 100 });
  let writes = 0;
  try {
    const loader = async path => { writes++; await writeFile(path, 'audio'); };
    const a = await cache.acquire('same', 5, loader);
    assert.equal((await readFile(a.path)).toString(), 'audio');
    await a.release();
    const b = await cache.acquire('same', 5, loader);
    assert.equal(writes, 1);
    await new Promise(r => setTimeout(r, 55));
    await cache.sweep();
    assert.equal((await readFile(b.path)).toString(), 'audio', 'active lease remains readable');
    await b.release();
    assert.equal((await readdir(dir)).length, 0);
  } finally { cache.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SSD cache rejects oversized files and cleans failed downloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ump-disk-test-'));
  const cache = createDiskCache({ directory: dir, maxBytes: 20, maxFileBytes: 10 });
  try {
    await assert.rejects(cache.acquire('large', 11, async () => {}), /limit/);
    await assert.rejects(cache.acquire('broken', 5, async path => { await writeFile(path, 'no'); }), /Incomplete/);
    assert.deepEqual(await readdir(dir), []);
  } finally { cache.close(); await rm(dir, { recursive: true, force: true }); }
});
