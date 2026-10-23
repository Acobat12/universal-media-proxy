import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMediaTranslation } from '../src/media-translation.js';
import { registry } from '../src/core/adapter-loader.js';

test('Bilibili declines unrelated VOT payloads', async () => {
  const adapter = registry.adapters.find(a => a.id === 'bilibili');
  assert.equal(await adapter.prepareMediaTranslation(Buffer.from('other-site'), { publicBaseUrl: 'https://proxy.example' }), null);
});

test('new VOT adapter can handle a request after Bilibili declines', async () => {
  const adapter = { id: 'test-vot-plugin', matches: () => false, resolve: async () => ({}),
    prepareMediaTranslation: async body => body.toString() === 'third-site' ? { body, mediaUrl: 'https://proxy.example/media/third-site' } : null };
  registry.register(adapter);
  try {
    const result = await prepareMediaTranslation(Buffer.from('third-site'), { publicBaseUrl: 'https://proxy.example' });
    assert.equal(result.mediaUrl, 'https://proxy.example/media/third-site');
  } finally {
    registry.adapters.splice(registry.adapters.indexOf(adapter), 1);
  }
});
