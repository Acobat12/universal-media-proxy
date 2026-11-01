import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaFileCache } from '../src/core/media-file-cache.js';

test('media cache removes expired files but retains active media and unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ump-media-test-'));
  const cache = createMediaFileCache({ directory, ttlMs: 1000, maxBytes: 100, sweepMs: 100000 });
  try {
    const expired = join(directory, 'expired123.m4a');
    const active = join(directory, 'active123.m4a');
    const unrelated = join(directory, 'do-not-delete.txt');
    await Promise.all([writeFile(expired, 'old'), writeFile(active, 'active'), writeFile(unrelated, 'safe')]);
    const old = new Date(Date.now() - 10000);
    await Promise.all([utimes(expired, old, old), utimes(active, old, old)]);
    cache.retain('active123');
    await cache.sweep();
    await assert.rejects(stat(expired), { code: 'ENOENT' });
    assert.equal((await stat(active)).size, 6);
    assert.equal((await stat(unrelated)).size, 4);
    cache.release('active123');
    await cache.sweep();
    await assert.rejects(stat(active), { code: 'ENOENT' });
  } finally { cache.close(); await rm(directory, { recursive: true, force: true }); }
});

test('media cache evicts oldest files when size exceeds budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ump-media-budget-'));
  const cache = createMediaFileCache({ directory, ttlMs: 60000, maxBytes: 5, sweepMs: 100000 });
  try {
    const oldest = join(directory, 'oldest123.m4a');
    const newest = join(directory, 'newest123.m4a');
    await writeFile(oldest, '1234');
    await writeFile(newest, '5678');
    const old = new Date(Date.now() - 10000);
    await utimes(oldest, old, old);
    await cache.sweep();
    await assert.rejects(stat(oldest), { code: 'ENOENT' });
    assert.equal((await stat(newest)).size, 4);
  } finally { cache.close(); await rm(directory, { recursive: true, force: true }); }
});
