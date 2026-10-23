import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Registry } from './registry.js';

const defaultDirectory = fileURLToPath(new URL('../adapters/', import.meta.url));

// Only direct .js files are plugins. Backups, directories and hidden files are ignored.
export async function loadAdapters({ directory = defaultDirectory } = {}) {
  const registry = new Registry();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/^[a-zA-Z0-9][\w-]*\.js$/.test(entry.name)) continue;
    const module = await import(pathToFileURL(join(directory, entry.name)).href);
    const adapter = module.default ?? module[entry.name.slice(0, -3)];
    if (!adapter) throw new Error(`Adapter ${entry.name} must export default or a named export matching its filename`);
    try { registry.register(adapter); }
    catch (error) { throw new Error(`Invalid adapter ${entry.name}: ${error.message}`, { cause: error }); }
  }
  return registry;
}

export const registry = await loadAdapters();
