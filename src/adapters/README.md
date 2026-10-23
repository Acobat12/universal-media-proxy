# Adding a website

Add `src/adapters/example.js` (a `.js` file directly in this directory), then restart Node. The loader ignores `.bak` and hidden files. A broken plugin stops startup with an error instead of silently disabling a site.

```js
export default {
  id: 'example',
  // Trusted CDN domains required by this adapter; no schemes, paths, or wildcards.
  mediaHosts: ['cdn.example.com'],
  matches(url) {
    return url.protocol === 'https:' && url.hostname === 'example.com' && url.pathname.startsWith('/video/');
  },
  async resolve(url, { fetcher, quality, signal }) {
    // Implement extraction for the real site's documented/public API.
    // Do not fetch arbitrary user-provided URLs or credentials.
    return {
      site: 'example', id: url.pathname.split('/').pop(),
      contentType: 'audio/mp4',
      upstreams: ['https://cdn.example.com/path-to-real-media.mp4'],
      headers: {}, metadata: { quality }
    };
  }
};
```

`mediaHosts` are automatically added to the CDN allowlist. Only declare trusted, public domains: all media URLs are still checked for HTTPS and public DNS addresses. Alternatively configure `ALLOWED_UPSTREAM_HOSTS` in the environment. `GET /health` lists loaded adapters.

Note: The generic `/api/resolve` endpoint uses every adapter. Bilibili's protobuf URL rewriting/stable media route and Douyin's browser registration/stable media route remain site-specific. Adding a generic adapter does not automatically enable these special integrations or bypass login/DRM.

### VOT media translation hook

An adapter can optionally implement `async prepareMediaTranslation(body, { publicBaseUrl })`.
Return `{ body, mediaUrl }` when the signed request belongs to the adapter, or `null` if it does not. The core dispatcher checks adapters in descending `mediaTranslationPriority` order (default `0`). Avoid modifying signed request bytes unless the signing flow explicitly supports it.
Site-specific translation logic belongs in its adapter, not in `src/media-translation.js`.

### VOT dispatch rules

`prepareMediaTranslation(body, context)` must return `null` for requests belonging to
other sites. Return `{ body, mediaUrl }` when it handles the request, and throw only
when a request recognized as belonging to that adapter is malformed. This lets
additional site adapters participate without editing `media-translation.js`.
The dispatcher tries higher `mediaTranslationPriority` values first.
