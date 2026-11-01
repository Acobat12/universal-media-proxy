import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import { createMediaFileCache } from './media-file-cache.js';

// One source of configuration for all generated audio. Adapter-specific cache
// environment variables are intentionally not used.
const root = resolve(process.env.DISK_CACHE_DIR || join(tmpdir(), 'universal-media-proxy-cache'));
const ttlMs = Number(process.env.DISK_CACHE_TTL_MS || 900000);
const maxBytes = Number(process.env.DISK_CACHE_MAX_BYTES || 1073741824);
const sweepMs = Number(process.env.MEDIA_CACHE_SWEEP_MS || 60000);
if (![ttlMs, maxBytes, sweepMs].every(v => Number.isSafeInteger(v) && v > 0)) {
  throw new Error('Invalid shared media cache configuration');
}
const namespaces = new Map();
let pending = null;
const mediaName = /^[A-Za-z0-9_-]{4,256}\.m4a$/;

export function mediaCacheConfig() { return { root, ttlMs, maxBytes, sweepMs }; }

export function adapterMediaCache(namespace, isBusy = () => false) {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(namespace)) throw new Error('Invalid cache namespace');
  if (namespaces.has(namespace)) throw new Error(`Duplicate media cache namespace: ${namespace}`);
  const directory = join(root, namespace);
  // Each namespace sweeps expired/partial files. A shared global sweep enforces
  // the ONE disk budget across all adapter-generated M4A files.
  const local = createMediaFileCache({ directory, ttlMs, maxBytes, sweepMs, isBusy });
  const active = new Map();
  const cache = {
    directory,
    retain(id) { active.set(id, (active.get(id) || 0) + 1); local.retain(id); },
    release(id) { const count = active.get(id) || 0; if (count <= 1) active.delete(id); else active.set(id, count - 1); local.release(id); },
    async sweep() { await local.sweep(); await sweepAllMediaCaches(); },
    isBusy: id => active.has(id) || isBusy(id)
  };
  namespaces.set(namespace, cache);
  return cache;
}

export async function sweepAllMediaCaches() {
  if (pending) return pending;
  pending = (async () => {
    const files = [];
    let total = 0;
    const now = Date.now();
    for (const cache of namespaces.values()) {
      await mkdir(cache.directory, { recursive: true });
      for (const name of await readdir(cache.directory)) {
        if (!mediaName.test(name)) continue;
        const id = name.slice(0, -4);
        const path = join(cache.directory, name);
        let info;
        try { info = await stat(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (!info.isFile()) continue;
        if (cache.isBusy(id)) continue;
        if (now - info.mtimeMs >= ttlMs) {
          await rm(path, { force: true });
          continue;
        }
        files.push({ path, size: info.size, mtimeMs: info.mtimeMs, cache, id });
        total += info.size;
      }
    }
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) break;
      if (file.cache.isBusy(file.id)) continue;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  })();
  try { await pending; } finally { pending = null; }
}
const timer = setInterval(() => sweepAllMediaCaches().catch(e => console.error('[Media cache] global sweep failed:', e)), sweepMs);
timer.unref?.();
