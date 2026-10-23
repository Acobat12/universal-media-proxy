import { fail } from './errors.js';
import { safeHostname } from './security.js';
export class Registry {
  constructor(adapters = []) { this.adapters = [...adapters]; }
  register(adapter) {
    if (!adapter?.id || typeof adapter.matches !== 'function' || typeof adapter.resolve !== 'function') throw Error('Invalid adapter');
    if (this.adapters.some(x => x.id === adapter.id)) throw Error('Duplicate adapter');
    if (adapter.mediaHosts !== undefined && (!Array.isArray(adapter.mediaHosts) || adapter.mediaHosts.some(h => typeof h !== 'string' || h !== h.toLowerCase() || !/^[a-z0-9.-]+$/.test(h) || !safeHostname(h)))) throw Error('Invalid mediaHosts');
    this.adapters.push(adapter); return this;
  }
  find(url) { const adapter = this.adapters.find(x => x.matches(url)); if (!adapter) fail(422, 'Unsupported site'); return adapter; }
}
