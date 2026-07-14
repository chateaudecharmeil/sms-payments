// Shared Playwright launcher for driving sumup.com in this environment.
//
// - Persistent profile in ~/.sumup-profile so the SumUp login survives between
//   runs while the container is alive (cookies are NOT committed to git).
// - Routes traffic through the session's egress proxy (HTTPS_PROXY) and trusts
//   its CA via the pre-configured NSS store.
//
// Usage from an ad-hoc script:
//   import { launch } from './browser-lib.mjs';
//   const { context, page } = await launch();
//   await page.goto('https://me.sumup.com/');
//   await page.screenshot({ path: 'screenshots/step.png', fullPage: true });
//   await context.close();

import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const PROFILE_DIR = path.join(os.homedir(), '.sumup-profile');
export const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');

export async function launch({ headless = true } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    // Pre-installed browser in this environment; never run `playwright install`.
    executablePath: '/opt/pw-browsers/chromium',
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    viewport: { width: 1440, height: 900 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });

  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  return { context, page };
}

export async function shot(page, name) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
