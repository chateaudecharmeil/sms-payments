// Open a URL (default: the SumUp dashboard) and save a screenshot.
// Starting point for each browsing session — look at the screenshot, then drive
// the page further with ad-hoc scripts using browser-lib.mjs.
//
// Usage: node scripts/sumup-open.mjs [url]

import { launch, shot } from './browser-lib.mjs';

const url = process.argv[2] ?? 'https://me.sumup.com/';

const { context, page } = await launch();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  const file = await shot(page, 'sumup-open');
  console.log(`URL now: ${page.url()}`);
  console.log(`Title:   ${await page.title()}`);
  console.log(`Shot:    ${file}`);
} finally {
  await context.close();
}
