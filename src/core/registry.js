import { fail } from './errors.js';
export class Registry {
  constructor(adapters = []) { this.adapters = [...adapters]; }
  register(adapter) {
    if (!adapter?.id || typeof adapter.matches !== 'function' || typeof adapter.resolve !== 'function') throw Error('Invalid adapter');
    if (this.adapters.some(x => x.id === adapter.id)) throw Error('Duplicate adapter');
    this.adapters.push(adapter); return this;
  }
  find(url) { const adapter = this.adapters.find(x => x.matches(url)); if (!adapter) fail(422, 'Unsupported site'); return adapter; }
}
