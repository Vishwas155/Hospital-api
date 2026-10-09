import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from './config';

let contextPromise: Promise<BrowserContext> | null = null;
let browser: Browser | null = null;

function proxySettings() {
  if (!config.proxyUrl) return undefined;
  const url = new URL(config.proxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    username: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
  };
}

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * One headless Chromium and one browser context for the whole process, kept warm between
 * requests (launching Chromium costs ~1 s). Relaunched if it crashes.
 */
function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      browser = await chromium.launch({
        headless: true,
        proxy: proxySettings(),
        // Containers often have a tiny /dev/shm, which crashes Chromium tabs.
        args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      });
      browser.on('disconnected', () => {
        contextPromise = null;
        browser = null;
        idlePages.length = 0;
        openPages = 0;
      });
      const context = await browser.newContext({
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
        userAgent: DESKTOP_CHROME_UA,
        viewport: { width: 1600, height: 1000 },
      });
      // Skip images, video and fonts: they are most of the bytes and none of the data.
      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        return type === 'image' || type === 'media' || type === 'font' ? route.abort() : route.continue();
      });
      return context;
    })().catch((err) => {
      contextPromise = null;
      throw err;
    });
  }
  return contextPromise;
}

// A small pool of reusable tabs shared by all requests, capped at MAX_BROWSER_TABS.
const idlePages: Page[] = [];
const waiting: ((page: Page | null) => void)[] = [];
let openPages = 0;

async function acquirePage(): Promise<Page> {
  const idle = idlePages.pop();
  if (idle && !idle.isClosed()) return idle;
  if (openPages < config.maxBrowserTabs) {
    openPages++;
    try {
      return await (await getContext()).newPage();
    } catch (err) {
      openPages--;
      throw err;
    }
  }
  const handedOver = await new Promise<Page | null>((resolve) => waiting.push(resolve));
  return handedOver ?? acquirePage();
}

function releasePage(page: Page, healthy: boolean): void {
  if (!healthy || page.isClosed()) {
    openPages = Math.max(0, openPages - 1);
    page.close().catch(() => {});
    waiting.shift()?.(null); // let a waiter open a fresh tab
    return;
  }
  const next = waiting.shift();
  if (next) next(page);
  else idlePages.push(page);
}

/** Starts Chromium ahead of the first request, which would otherwise pay its ~1-2 s launch. */
export async function warmUpBrowser(): Promise<void> {
  await getContext();
}

/** Runs `fn` with a browser tab from the pool, waiting for one if all are busy. */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await acquirePage();
  let healthy = true;
  try {
    return await fn(page);
  } catch (err) {
    healthy = false; // a tab left mid-navigation can misbehave; replace it
    throw err;
  } finally {
    releasePage(page, healthy);
  }
}

export async function closeBrowser(): Promise<void> {
  const current = browser;
  contextPromise = null;
  browser = null;
  await current?.close().catch(() => {});
}
