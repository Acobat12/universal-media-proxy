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

test('concurrent writers reserve capacity before writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ump-reservation-test-'));
  const cache = createDiskCache({ directory: dir, maxBytes: 10, maxFileBytes: 10 });
  let started;
  const writerStarted = new Promise(resolve => { started = resolve; });
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  try {
    const first = cache.acquire('first', 7, async path => { started(); await gate; await writeFile(path, '1234567'); });
    // Allow the first acquire to reach its writer.
    await writerStarted;
    assert.equal(cache.stats().reservedBytes, 7);
    await assert.rejects(cache.acquire('second', 7, async path => writeFile(path, '1234567')), /capacity exhausted/);
    unblock();
    const lease = await first;
    await lease.release();
    assert.equal(cache.stats().reservedBytes, 0);
  } finally { unblock(); cache.close(); await rm(dir, { recursive: true, force: true }); }
});

test('core reservation respects existing M4A files in the shared cache root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ump-shared-test-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'nhk'));
  await writeFile(join(root, 'nhk', 'sample123.m4a'), Buffer.alloc(8));
  const cache = createDiskCache({ directory: join(root, 'core'), maxBytes: 10, maxFileBytes: 10 });
  try {
    await assert.rejects(cache.acquire('other', 5, async path => writeFile(path, Buffer.alloc(5))), /capacity exhausted/);
  } finally { cache.close(); await rm(root, { recursive: true, force: true }); }
});
