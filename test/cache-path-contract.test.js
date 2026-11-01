import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskCache } from '../src/core/disk-cache.js';

test('core cache defaults to configured shared media root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ump-cache-contract-'));
  const previous = process.env.DISK_CACHE_DIR;
  process.env.DISK_CACHE_DIR = root;
  try {
    const cache = createDiskCache({ sweepMs: 60000 });
    assert.equal(cache.directory, join(root, 'core'));
    cache.close();
  } finally {
    if (previous === undefined) delete process.env.DISK_CACHE_DIR;
    else process.env.DISK_CACHE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
