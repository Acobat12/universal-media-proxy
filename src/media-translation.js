// Site-independent VOT translation dispatcher. Site-specific logic lives in adapters.
import { registry } from './core/adapter-loader.js';

export async function prepareMediaTranslation(body, context) {
  for (const adapter of [...registry.adapters].sort((a, b) => (b.mediaTranslationPriority ?? 0) - (a.mediaTranslationPriority ?? 0))) {
    if (typeof adapter.prepareMediaTranslation !== 'function') continue;
    const result = await adapter.prepareMediaTranslation(body, context);
    if (result) return result;
  }
  throw Error('No adapter can prepare this media translation');
}
