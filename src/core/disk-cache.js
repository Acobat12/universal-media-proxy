import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// A private directory dedicated to disposable media, never arbitrary user paths.
export function createDiskCache({ directory = join(tmpdir(), 'universal-media-proxy-cache'), ttlMs = 900000, maxBytes = 1024 ** 3, maxFileBytes = 256 * 1024 ** 2, sweepMs = 30000 } = {}) {
  directory = resolve(directory);
  if (![ttlMs, maxBytes, maxFileBytes, sweepMs].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid disk cache limits');
  const entries = new Map();
  let used = 0;
  let ready;
  async function init() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Remove abandoned files from earlier server runs (only our own prefixed files).
    for (const name of await readdir(directory)) if (/^ump-[a-f0-9-]+\.(?:part|bin)$/.test(name)) await rm(join(directory, name), { force: true }).catch(() => {});
  }
  const ensure = () => ready ||= init();
  async function remove(entry) {
    if (entry.removed || entry.refs || entry.pending) return false;
    entry.removed = true;
    entries.delete(entry.key);
    used -= entry.size;
    await rm(entry.path, { force: true }).catch(() => {});
    return true;
  }
  async function sweep() {
    const now = Date.now();
    for (const e of [...entries.values()]) if (e.expires <= now) await remove(e);
    for (const e of [...entries.values()].sort((a,b) => a.accessed - b.accessed)) {
      if (used <= maxBytes) break;
      await remove(e);
    }
  }
  const timer = setInterval(() => { sweep().catch(console.error); }, sweepMs);
  timer.unref?.();
  async function acquire(key, expectedSize, writer) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > maxFileBytes || expectedSize > maxBytes) throw Error('File exceeds disk cache limit');
    await ensure();
    await sweep();
    let e = entries.get(key);
    if (!e) {
      const id = randomUUID();
      const path = join(directory, `ump-${id}.bin`);
      const temp = join(directory, `ump-${id}.part`);
      e = { key, path, size: expectedSize, refs: 0, pending: true, expires: Infinity, accessed: Date.now(), removed: false };
      entries.set(key, e);
      e.pending = (async () => {
        try {
          await writer(temp);
          if ((await stat(temp)).size !== expectedSize) throw Error('Incomplete cached audio');
          await rename(temp, path);
          e.pending = null;
          e.expires = Date.now() + ttlMs;
          used += expectedSize;
          await sweep();
        } catch (err) {
          entries.delete(key);
          e.pending = null;
          await rm(temp, { force: true }).catch(() => {});
          await rm(path, { force: true }).catch(() => {});
          throw err;
        }
      })();
    }
    // Reserve the file while waiting so the sweep cannot remove it before reading.
    e.refs++;
    try { if (e.pending) await e.pending; }
    catch (err) { e.refs--; throw err; }
    e.accessed = Date.now();
    return { path: e.path, release: async () => { e.refs--; if (e.expires <= Date.now()) await remove(e); } };
  }
  return { acquire, sweep, stats: () => ({ entries: entries.size, bytes: used }), close: () => clearInterval(timer), directory };
}
