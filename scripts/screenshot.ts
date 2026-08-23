/**
 * Regenerate the README screenshots.
 *
 *   npm run screenshot
 *
 * Drives the running stack in a real browser and writes PNGs to
 * docs/screenshots. Two details worth knowing:
 *
 *   It waits on `domcontentloaded` plus a fixed settle, never on network idle.
 *   The dashboard holds an open Server-Sent Events connection, so the page
 *   never *reaches* idle - a headless run keyed on that hangs until it is
 *   killed, which is exactly what happened the first time.
 *
 *   It uses the browser already installed on the machine via playwright-core,
 *   rather than downloading one. Nothing here belongs in the production
 *   image; this is a documentation tool.
 *
 * Requires the stack to be up: `docker compose up -d`.
 */

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'docs', 'screenshots');

const BASE = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:5173';

/** Common install locations; the first that exists wins. */
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((candidate): candidate is string => Boolean(candidate));

interface Shot {
  name: string;
  path: string;
  /** Settle time after load, for charts to finish their first render. */
  settleMs?: number;
  /** Accessible name of a button to click before capturing. */
  click?: string;
}

const SHOTS: Shot[] = [
  { name: 'dashboards', path: '/', settleMs: 4_000 },
  { name: 'query-builder', path: '/explore', settleMs: 4_000, click: 'Run query' },
];

function findBrowser(): string {
  const found = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No Chrome or Edge found. Set CHROME_PATH, or install one of:\n  ${BROWSER_CANDIDATES.join('\n  ')}`,
    );
  }
  return found;
}

/** The demo dashboard's id, so its URL does not have to be hardcoded. */
async function resolveDashboardPath(browser: Browser): Promise<string | null> {
  const context = await browser.newContext();
  try {
    const response = await context.request.get(`${BASE}/api/dashboards`);
    if (!response.ok()) return null;

    const body = (await response.json()) as { dashboards: { id: string; name: string }[] };
    const target =
      body.dashboards.find((dashboard) => dashboard.name === 'Sales overview') ??
      body.dashboards[0];

    return target ? `/dashboards/${target.id}` : null;
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: findBrowser(),
    args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
  });

  try {
    const dashboardPath = await resolveDashboardPath(browser);
    const shots = dashboardPath
      ? [{ name: 'dashboard', path: dashboardPath, settleMs: 7_000 }, ...SHOTS]
      : SHOTS;

    const page = await browser.newPage({
      viewport: { width: 1500, height: 1000 },
      // Retina-density captures, so the images stay sharp in the README.
      deviceScaleFactor: 2,
      colorScheme: 'dark',
    });

    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    for (const shot of shots) {
      await page.goto(`${BASE}${shot.path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(shot.settleMs ?? 4_000);

      if (shot.click) {
        await page.getByRole('button', { name: shot.click, exact: true }).first().click();
        await page.waitForTimeout(5_000);
      }

      const file = path.join(OUT_DIR, `${shot.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  ${shot.name}.png`);
    }

    if (problems.length > 0) {
      console.warn(`\nPage reported ${problems.length} problem(s):`);
      for (const problem of problems) console.warn(`  - ${problem}`);
    } else {
      console.log('\nNo console or page errors.');
    }
  } finally {
    await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Screenshot run failed:');
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
