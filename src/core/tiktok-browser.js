import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// A single persistent Chromium profile is reused for all TikTok requests.
const profileDir = resolve(process.env.TIKTOK_PROFILE_DIR || '/var/cache/universal-media-proxy/tiktok-profile');
const maxPages = Math.max(1, Math.min(5, Number(process.env.TIKTOK_MAX_PAGES) || 2));
let contextPromise;
let context;
let active = 0;
const waiters = [];
let lastRefresh = 0;
let refreshPromise;

function log(reason, details = {}) {
  console.log('[TIKTOK BROWSER]', JSON.stringify({ reason, ...details }));
}
async function launch() {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true, args: ['--no-sandbox'],
  });
  ctx.on('close', () => {
    if (context === ctx) { context = undefined; contextPromise = undefined; }
    log('context-closed');
  });
  context = ctx;
  log('started');
  return ctx;
}
export async function getTikTokContext() {
  if (!contextPromise) {
    contextPromise = launch().catch(err => {
      contextPromise = undefined;
      context = undefined;
      throw err;
    });
  }
  const ctx = await contextPromise;
  // A closed context may race with callers; create a fresh one next time.
  if (ctx !== context) {
    contextPromise = undefined;
    return getTikTokContext();
  }
  return ctx;
}
async function acquire() {
  if (active >= maxPages) await new Promise(resolve => waiters.push(resolve));
  active++;
}
function release() {
  active--;
  waiters.shift()?.();
}
export async function withTikTokPage(callback) {
  await acquire();
  let page;
  try {
    const ctx = await getTikTokContext();
    page = await ctx.newPage();
    return await callback(page, ctx);
  } finally {
    if (page) await page.close().catch(() => {});
    release();
  }
}
export async function refreshTikTokCookies() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = withTikTokPage(async page => {
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    lastRefresh = Date.now();
    log('session-refreshed');
  }).catch(err => log('session-refresh-failed', { error: err.message?.slice(0, 120) }))
    .finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}
// Lazy browser startup: no Chromium cost for non-TikTok traffic.
// Visiting TikTok can refresh cookies naturally; this is a best-effort refresh.
const interval = setInterval(() => {
  if (!context || !contextPromise) return;
  if (Date.now() - lastRefresh > 60 * 60 * 1000 && active === 0) {
    void refreshTikTokCookies();
  }
}, 5 * 60 * 1000);
interval.unref?.();
