import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDiskUsage } from '../src/core/cache-disk-usage.js';

test('counts recognized media in future adapter namespaces but ignores registrations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ump-usage-test-'));
  try {
    await mkdir(join(root, 'douyin'));
    await mkdir(join(root, 'tiktok'));
    await writeFile(join(root, 'douyin', 'sample123.m4a'), Buffer.alloc(17));
    await writeFile(join(root, 'tiktok', 'registration.json'), Buffer.alloc(100));
    await writeFile(join(root, 'tiktok', 'sample123.123.456.partial.m4a'), Buffer.alloc(11));
    assert.equal(await cacheDiskUsage(root), 28);
  } finally { await rm(root, { recursive: true, force: true }); }
});
