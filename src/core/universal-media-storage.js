// Public storage contract for current and future media adapters.
// Registration/state files must NOT be placed under this root.
import { mkdir, readdir, stat, rm, statfs, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(process.env.DISK_CACHE_DIR || join(tmpdir(), 'universal-media-proxy-cache'));
const maxBytes = Number(process.env.DISK_CACHE_MAX_BYTES || 1024 ** 3);
const ttlMs = Number(process.env.DISK_CACHE_TTL_MS || 900000);
if (![maxBytes, ttlMs].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid disk cache configuration');
const reservations = new Map();
const activeOutputs = new Map();
const minFreeBytes = Number(process.env.DISK_CACHE_MIN_FREE_BYTES ?? 128 * 1024 ** 2);
if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) throw Error('Invalid disk free-space reserve');
let nextId = 0;
let queue = Promise.resolve();
const within = p => p === root || p.startsWith(root + sep);

async function walk(dir, files) {
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const item of items) {
    if (item.isSymbolicLink()) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) await walk(path, files);
    else if (item.isFile()) {
      try { const s = await stat(path); files.push({ path, size: s.size, mtimeMs: s.mtimeMs }); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
}

function locked(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function mediaStorageConfig() { return { root, maxBytes, ttlMs }; }
export function mediaStorageDirectory(namespace) {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(namespace)) throw Error('Invalid media namespace');
  return join(root, namespace);
}
export async function mediaStorageUsage() {
  const files = [];
  await walk(root, files);
  return files.reduce((sum, file) => sum + file.size, 0);
}
// Reservations are process-local. Writers MUST use this contract and enforce
// their own byte ceilings; legacy writers are not automatically constrained.
export async function reserveMediaBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxBytes) throw Error('Invalid media reservation');
  return locked(async () => {
    await mkdir(root, { recursive: true });
    const used = await mediaStorageUsage();
    const pending = [...reservations.values()].reduce((sum, n) => sum + n, 0);
    if (used + pending + bytes > maxBytes) {
      await sweepManagedUnlocked();
      if (await mediaStorageUsage() + pending + bytes > maxBytes) throw Error('Shared media cache capacity exhausted');
    }
    const id = ++nextId;
    reservations.set(id, bytes);
    let released = false;
    const monitored = new Set();
    let exceeded = null;
    let checking = false;
    let interval;
    async function check() {
      if (released || checking || exceeded) return;
      checking = true;
      try {
        const files = [];
        for (const path of monitored) {
          const target = resolve(path);
          if (!within(target)) throw Error('Media output outside shared cache');
          try { const info = await stat(target);
            if (info.isDirectory()) await walk(target, files);
            else if (info.isFile()) files.push({ path: target, size: info.size });
          } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        const actual = [...new Map(files.map(f => [f.path, f])).values()].reduce((n, f) => n + f.size, 0);
        // The limit is a target, not a reason to interrupt active playback.
        // Sweep inactive files and leave in-flight writes intact.
        if (actual > bytes || await mediaStorageUsage() > maxBytes) {
          await sweepManagedUnlocked();
        }
        const space = await statfs(root);
        if (space.bavail * space.bsize < minFreeBytes) {
          exceeded = Error('Insufficient free disk space for media conversion');
          for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
        }
      } catch (e) { exceeded = e; }
      finally { checking = false; }
    }
    const children = new Set();
    return {
      bytes,
      watch(path) { if (released) throw Error('Reservation released'); const target = resolve(path); if (!within(target)) throw Error('Media output outside shared cache'); monitored.add(target); activeOutputs.set(target, (activeOutputs.get(target) || 0) + 1); if (!interval) { interval = setInterval(() => { check().catch(() => {}); }, 100); interval.unref?.(); } },
      track(child) { children.add(child); child.once('close', () => children.delete(child)); },
      async verify() { await check(); if (exceeded) throw exceeded; },
      release() { if (!released) { released = true; if (interval) clearInterval(interval); reservations.delete(id); for (const path of monitored) { const n = activeOutputs.get(path) || 0; if (n <= 1) activeOutputs.delete(path); else activeOutputs.set(path, n - 1); } sweepAllAdapterMedia().catch(e => console.error('[Media storage] post-write sweep:', e)); } }
    };
  });
}
export async function withMediaReservation(bytes, fn) {
  const reservation = await reserveMediaBytes(bytes);
  try { return await fn(reservation); } finally { reservation.release(); }
}
// Only explicitly managed cache files should be swept. Caller provides a
// busy-file predicate; no blind deletion of unknown adapter data.
async function sweepFilesUnlocked(isManaged, isBusy = () => false) {
  const files = [];
  await walk(root, files);
  const now = Date.now();
  let used = files.reduce((sum, f) => sum + f.size, 0);
  let deleted = 0;
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (!within(resolve(file.path)) || !isManaged(file.path) || isBusy(file.path)) continue;
    if (now - file.mtimeMs < ttlMs && used <= maxBytes) continue;
    try { await rm(file.path); used -= file.size; deleted++; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { used, deleted };
}
export async function sweepMediaFiles(isManaged, isBusy = () => false) {
  if (typeof isManaged !== 'function') throw Error('Managed-file predicate required');
  return locked(() => sweepFilesUnlocked(isManaged, isBusy));
}

// Single adapter-facing storage API. New adapters need no changes to UMP core.
const adapterStores = new Map();
let sweepInFlight;
const disposableName = /^(?:[A-Za-z0-9_-]{4,256}\.m4a|[A-Za-z0-9_-]{4,256}\.\d+\.\d+\.partial\.m4a(?:\.hls-input)?|[A-Za-z0-9_-]{4,256}\.\d+\.\d+\.segments\/.+)$/;
export function createAdapterMediaStorage(namespace, isBusy = () => false) {
  if (adapterStores.has(namespace)) throw Error(`Duplicate media namespace: ${namespace}`);
  const directory = mediaStorageDirectory(namespace);
  const active = new Map();
  const store = {
    directory,
    retain(id) { active.set(id, (active.get(id) || 0) + 1); },
    release(id) { const n = active.get(id) || 0; if (n <= 1) active.delete(id); else active.set(id, n - 1); },
    isBusy(id) { return active.has(id) || isBusy(id); },
    reserve: reserveMediaBytes,
    sweep: sweepAllAdapterMedia
  };
  adapterStores.set(namespace, store);
  return store;
}
function isManagedMedia(path) {
  const relative = path.slice(root.length + 1).split(sep);
  return relative.length >= 2 && adapterStores.has(relative[0]) &&
    disposableName.test(relative.slice(1).join('/'));
}
function isBusyMedia(path) {
  for (const output of activeOutputs.keys()) {
    if (path === output || path.startsWith(output + sep)) return true;
  }
  const relative = path.slice(root.length + 1).split(sep);
  const store = adapterStores.get(relative[0]);
  return !store || store.isBusy(relative[1].split('.')[0]);
}
async function sweepManagedUnlocked() {
  return sweepFilesUnlocked(isManagedMedia, isBusyMedia);
}
export async function sweepAllAdapterMedia() {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = locked(sweepManagedUnlocked);
  try { return await sweepInFlight; } finally { sweepInFlight = null; }
}
const adapterSweepTimer = setInterval(() => sweepAllAdapterMedia().catch(e => console.error('[Media storage] sweep:', e)), 60000);
adapterSweepTimer.unref?.();


// Consolidated implementation: cache-disk-usage

// Read-only accounting of files owned by UMP's disposable media caches.
// Never follows symlinks and never counts registration/state directories.
const owned = /^(?:ump-[a-f0-9-]+\.(?:bin|part)|[A-Za-z0-9_-]{4,256}\.m4a|[A-Za-z0-9_-]{4,256}\.\d+\.\d+\.partial\.m4a(?:\.hls-input)?)$/;
const workdir = /^[A-Za-z0-9_-]{4,256}\.\d+\.\d+\.segments$/;
export async function cacheDiskUsage(root) {
  let bytes = 0;
  async function scan(dir, depth) {
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const item of items) {
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (depth === 0 && !/^[a-z][a-z0-9-]{0,40}$/.test(item.name)) continue; // All adapter namespaces; only recognized media files are counted
        if (depth === 1 && !workdir.test(item.name)) continue;
        if (depth < 2) await scan(path, depth + 1);
      } else if (item.isFile() && (owned.test(item.name) || depth === 2)) {
        try { bytes += (await stat(path)).size; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  }
  await scan(root, 0);
  return bytes;
}


// Consolidated implementation: media-file-cache

// Disk-backed cache maintenance for adapter-generated M4A files.
// Only filenames generated by the adapters are eligible for deletion.
export function createMediaFileCache({ directory, ttlMs = 900000, maxBytes = 512 * 1048576, sweepMs = 60000, isBusy = () => false }) {
  directory = resolve(directory);
  if (![ttlMs, maxBytes, sweepMs].every(n => Number.isSafeInteger(n) && n > 0))
    throw new Error('Invalid media file cache limits');
  const active = new Map();
  const filename = /^[A-Za-z0-9_-]{4,256}\.m4a$/;
  const workfile = /^[A-Za-z0-9_-]{4,256}\.\d+\.\d+\.partial\.m4a(?:\.hls-input)?$/;
  const workdir = /^[A-Za-z0-9_-]{4,256}\.\d+\.\d+\.segments$/;
  let running;
  const retain = id => active.set(id, (active.get(id) || 0) + 1);
  const release = id => {
    const count = active.get(id) || 0;
    if (count === 0) return;
    if (count === 1) active.delete(id);
    else active.set(id, count - 1);
  };
  const busy = id => active.has(id) || isBusy(id);
  async function sweep() {
    if (running) return running;
    running = (async () => {
      await mkdir(directory, { recursive: true });
      const now = Date.now();
      const files = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = entry.name;
        if (!filename.test(name) && !workfile.test(name) && !workdir.test(name)) continue;
        const id = name.split('.')[0];
        if (busy(id)) continue;
        const path = join(directory, name);
        let info;
        try { info = await stat(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if ((workfile.test(name) || workdir.test(name)) && now - info.mtimeMs >= ttlMs) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (!entry.isFile() || !filename.test(name)) continue;
        if (now - info.mtimeMs >= ttlMs) {
          await rm(path, { force: true });
          continue;
        }
        files.push({ path, id, size: info.size, mtimeMs: info.mtimeMs });
      }
      let total = files.reduce((sum, f) => sum + f.size, 0);
      for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total <= maxBytes) break;
        if (busy(f.id)) continue;
        await rm(f.path, { force: true });
        total -= f.size;
      }
    })();
    try { await running; } finally { running = null; }
  }
  const timer = setInterval(() => sweep().catch(e => console.error('[Media cache] sweep failed:', e)), sweepMs);
  timer.unref?.();
  return { directory, retain, release, sweep, close: () => clearInterval(timer) };
}


// Consolidated implementation: disk-cache

// A private directory dedicated to disposable media, never arbitrary user paths.
export function createDiskCache({ directory = join(resolve(process.env.DISK_CACHE_DIR || join(tmpdir(), 'universal-media-proxy-cache')), 'core'), ttlMs = Number(process.env.DISK_CACHE_TTL_MS || 900000), maxBytes = Number(process.env.DISK_CACHE_MAX_BYTES || 1024 ** 3), maxFileBytes = 256 * 1024 ** 2, sweepMs = 30000 } = {}) {
  directory = resolve(directory);
  if (![ttlMs, maxBytes, maxFileBytes, sweepMs].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid disk cache limits');
  const entries = new Map();
  let used = 0;
  let reserved = 0;
  let ready;
  async function init() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Files are ephemeral: after restart no in-memory index can reference them.
    // Delete only files owned by this cache, never registration metadata.
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
      // One shared reservation pool for all participating adapters.
      if (await cacheDiskUsage(dirname(directory)) + reserved + expectedSize > maxBytes) throw Error('Disk cache capacity exhausted');
      const reservation = await reserveMediaBytes(expectedSize);
      reserved += expectedSize;
      let reservationHeld = true;
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
          reserved -= expectedSize;
          reservation.release();
          reservationHeld = false;
          await sweep();
        } catch (err) {
          entries.delete(key);
          if (reservationHeld) { reserved -= expectedSize; reservation.release(); }
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
  return { acquire, sweep, stats: () => ({ entries: entries.size, bytes: used, reservedBytes: reserved }), close: () => clearInterval(timer), directory };
}
