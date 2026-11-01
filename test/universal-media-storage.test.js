import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('future namespaces share one reservation budget without code changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ump-storage-test-'));
  const old = { ...process.env };
  try {
    process.env.DISK_CACHE_DIR = dir;
    process.env.DISK_CACHE_MAX_BYTES = '100';
    process.env.DISK_CACHE_TTL_MS = '1000';
    const m = await import('../src/core/universal-media-storage.js?test=' + Date.now());
    const future = m.mediaStorageDirectory('future-adapter');
    await mkdir(future);
    await writeFile(join(future, 'video.part'), Buffer.alloc(30));
    assert.equal(await m.mediaStorageUsage(), 30);
    const r = await m.reserveMediaBytes(60);
    await assert.rejects(m.reserveMediaBytes(20), /capacity/);
    r.release();
    const r2 = await m.reserveMediaBytes(20);
    r2.release();
  } finally {
    Object.keys(process.env).forEach(k => { if (!(k in old)) delete process.env[k]; });
    Object.assign(process.env, old);
    await rm(dir, { recursive: true, force: true });
  }
});
