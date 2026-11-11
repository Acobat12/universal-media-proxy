import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const [site, url, profile] = process.argv.slice(2);
if (!site || !url || !profile) process.exit(2);
await mkdir(profile, { recursive: true, mode: 0o700 });
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: ['--no-sandbox'],
  viewport: { width: 1280, height: 800 },
});
const close = async () => { await ctx.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', close);
process.on('SIGINT', close);
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log(`Browser ready for ${site}. Close the terminal session to finish.`);
  await new Promise(resolve => ctx.on('close', resolve));
} catch (err) {
  console.error(err.message);
  await ctx.close().catch(() => {});
  process.exitCode = 1;
}
