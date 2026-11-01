import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('shared soft limit evicts inactive oldest media but preserves active and registration data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ump-soft-cache-'));
  const old = { ...process.env };
  try {
    process.env.DISK_CACHE_DIR = root;
    process.env.DISK_CACHE_MAX_BYTES = '100';
    process.env.DISK_CACHE_TTL_MS = '60000';
    process.env.DISK_CACHE_MIN_FREE_BYTES = '0';
    const m = await import('../src/core/universal-media-storage.js?soft=' + Date.now());
    const a = m.createAdapterMediaStorage('future-adapter');
    await mkdir(a.directory);
    const first = join(a.directory, 'aaaa.m4a');
    const second = join(a.directory, 'bbbb.m4a');
    const reg = join(a.directory, 'registration.json');
    await writeFile(first, Buffer.alloc(70));
    await new Promise(r => setTimeout(r, 15));
    await writeFile(second, Buffer.alloc(70));
    await writeFile(reg, '{}');
    a.retain('aaaa');
    await m.sweepAllAdapterMedia();
    await stat(first);
    await assert.rejects(stat(second), { code: 'ENOENT' });
    await stat(reg);
    a.release('aaaa');
  } finally {
    Object.keys(process.env).forEach(k => { if (!(k in old)) delete process.env[k]; });
    Object.assign(process.env, old);
    await rm(root, { recursive: true, force: true });
  }
});
