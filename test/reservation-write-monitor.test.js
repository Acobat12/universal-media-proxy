import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('reservation allows a small temporary overage without aborting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ump-quota-test-'));
  process.env.DISK_CACHE_DIR = root;
  process.env.DISK_CACHE_MAX_BYTES = '1024';
  const { reserveMediaBytes } = await import('../src/core/universal-media-storage.js');
  const reservation = await reserveMediaBytes(100);
  const file = join(root, 'output.part');
  try {
    reservation.watch(file);
    await writeFile(file, Buffer.alloc(101));
    await reservation.verify();
  } finally { reservation.release(); await rm(root, { recursive: true, force: true }); }
});
