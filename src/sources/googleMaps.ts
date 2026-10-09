import type { Page } from 'playwright';
import { normalizePhone, uniq } from '../normalize';

// Selectors below were taken from the live Google Maps UI (Oct 2026). Google changes class names
// occasionally; if scraping starts returning nothing, these are the first thing to check.
const SEL = {
  feed: 'div[role="feed"]',
  resultLink: 'div[role="feed"] a.hfpxzc',
  placeTitle: 'h1.DUwDvf',
  address: 'button[data-item-id="address"]',
  phone: '[data-item-id^="phone:tel:"]',
  website: 'a[data-item-id="authority"]',
  category: 'button.DkEaL',
  rating: 'div.F7nice span[aria-hidden="true"]',
  reviews: 'div.F7nice span[role="img"]',
};

const MAPS = 'https://www.google.com/maps';

export class GoogleBlockedError extends Error {
  constructor() {
    super('Google Maps returned its "unusual traffic" / captcha page');
  }
}

export interface GmapsPlace {
  name: string;
  href: string;
  lat: number;
  lng: number;
  placeId: string;
  address: string | null;
  phones: string[];
  website: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  open24h: boolean | null;
  /** True when read from the place page, false when only from a search result card. */
  detailed: boolean;
}

const jitter = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

/** Coordinates and a stable place id from a Google Maps place URL. */
export function parsePlaceHref(href: string): { lat: number; lng: number; placeId: string } | null {
  const coords = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const placeId = href.match(/!19s(ChIJ[\w-]+)/)?.[1] ?? href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/)?.[1];
  if (!coords || !placeId) return null;
  return { lat: Number(coords[1]), lng: Number(coords[2]), placeId };
}

/**
 * Parses the text of a search result card, e.g.
 *   "Fortis Hospital\n4.6\nHospital ·  · 14, Cunningham Rd\nOpen 24 hours · 096868 60310\nWebsite"
 */
export function parseResultCard(raw: { name: string; href: string; text: string }): GmapsPlace | null {
  const loc = parsePlaceHref(raw.href);
  if (!loc || !raw.name) return null;
  const lines = raw.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== raw.name);
  const infoLines = lines.filter((l) => l.includes('·')).map((l) => l.split('·').map((p) => p.trim()).filter(Boolean));
  const first = infoLines.find((parts) => !/^\d/.test(parts[0] ?? '')) ?? [];
  const rating = lines.map((l) => l.match(/^(\d\.\d)\b/)?.[1]).find(Boolean);
  const phones = infoLines
    .flat()
    .filter((p) => /^\+?[\d\s()-]{8,}$/.test(p))
    .map(normalizePhone)
    .filter((p): p is string => p !== null);

  return {
    name: raw.name.trim(),
    href: raw.href,
    ...loc,
    address: first.length > 1 ? first[first.length - 1] : null,
    phones: uniq(phones),
    website: null,
    category: first[0] ?? null,
    rating: rating ? Number(rating) : null,
    reviewCount: null,
    open24h: /open 24 hours/i.test(raw.text) ? true : null,
    detailed: false,
  };
}

function isBlocked(page: Page): boolean {
  return /\/sorry\//.test(page.url());
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // EU-hosted servers get a cookie consent interstitial first.
  if (page.url().includes('consent.google.')) {
    await page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first().click({ timeout: 10_000 });
    await page.waitForURL((u) => !u.hostname.startsWith('consent.'), { timeout: 20_000 });
  }
  if (isBlocked(page)) throw new GoogleBlockedError();
}

/** Scrolls the result list until Google says it has reached the end or no new results load. */
async function scrollResults(page: Page, maxRounds: number): Promise<void> {
  let lastCount = -1;
  let unchanged = 0;
  for (let round = 0; round < maxRounds; round++) {
    const count = await page.locator(SEL.resultLink).count();
    const ended = await page
      .$eval(SEL.feed, (feed) => /reached the end of the list/i.test((feed as HTMLElement).innerText))
      .catch(() => true);
    if (ended) return;
    unchanged = count === lastCount ? unchanged + 1 : 0;
    if (unchanged >= 3) return;
    lastCount = count;
    await page.$eval(SEL.feed, (feed) => feed.scrollTo(0, feed.scrollHeight));
    await page.waitForTimeout(jitter(1200, 2000));
  }
}

/**
 * Runs a Google Maps search (optionally pinned to a map viewport) and returns the result cards:
 * the first screen (~20) plus `scrolls` more pages of results.
 * When Google jumps straight to a single place, that place is returned instead.
 */
export async function searchPlaces(
  page: Page,
  query: string,
  at?: { lat: number; lng: number; zoom: number },
  scrolls = 0,
): Promise<GmapsPlace[]> {
  const path = `${MAPS}/search/${encodeURIComponent(query).replace(/%20/g, '+')}`;
  const url = at ? `${path}/@${at.lat.toFixed(6)},${at.lng.toFixed(6)},${at.zoom}z?hl=en` : `${path}?hl=en`;
  await open(page, url);

  const landed = await page.waitForSelector(`${SEL.feed}, ${SEL.placeTitle}`, { timeout: 20_000 }).catch(() => null);
  if (isBlocked(page)) throw new GoogleBlockedError();
  if (!landed) return []; // "Google Maps can't find ..."
  if (!(await page.$(SEL.feed))) {
    const place = await readPlacePage(page);
    return place ? [place] : [];
  }

  await page.waitForSelector(SEL.resultLink, { timeout: 8_000 }).catch(() => {});
  if (scrolls > 0) await scrollResults(page, scrolls);
  const cards = await page.$$eval(SEL.resultLink, (links) =>
    links.map((a) => ({
      name: a.getAttribute('aria-label') ?? '',
      href: (a as HTMLAnchorElement).href,
      text: (a.closest('div[jsaction]')?.parentElement as HTMLElement | null)?.innerText ?? '',
    })),
  );
  return cards.map(parseResultCard).filter((p): p is GmapsPlace => p !== null);
}

function unwrapGoogleRedirect(href: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.hostname.includes('google.') && url.pathname === '/url') return url.searchParams.get('q');
  } catch {
    return null;
  }
  return href;
}

async function readPlacePage(page: Page): Promise<GmapsPlace | null> {
  await page.waitForSelector(SEL.placeTitle, { timeout: 20_000 });
  // The info rows (address, phone, website) render a moment after the title, and when a search
  // jumps straight to a place, the URL only gains its coordinates a few seconds later.
  await page.waitForSelector(`${SEL.address}, ${SEL.phone}`, { timeout: 6_000 }).catch(() => {});
  await page.waitForURL(/!3d-?\d/, { timeout: 10_000 }).catch(() => {});

  const raw = await page.evaluate((sel) => {
    const main = document.querySelector('div[role="main"]') as HTMLElement | null;
    return {
      name: document.querySelector(sel.placeTitle)?.textContent?.trim() ?? '',
      address: document.querySelector(sel.address)?.getAttribute('aria-label') ?? '',
      phones: Array.from(document.querySelectorAll(sel.phone)).map(
        (el) => el.getAttribute('aria-label') || (el.getAttribute('data-item-id') ?? '').replace('phone:tel:', ''),
      ),
      website: (document.querySelector(sel.website) as HTMLAnchorElement | null)?.href ?? '',
      category: document.querySelector(sel.category)?.textContent?.trim() ?? '',
      rating: document.querySelector(sel.rating)?.textContent?.trim() ?? '',
      reviews: Array.from(document.querySelectorAll(sel.reviews))
        .map((el) => el.getAttribute('aria-label') ?? '')
        .find((label) => /review/i.test(label)) ?? '',
      open24h: /Open 24 hours/i.test(main?.innerText ?? ''),
      url: location.href,
    };
  }, SEL);

  const loc = parsePlaceHref(raw.url);
  if (!loc || !raw.name) return null;
  const rating = Number(raw.rating.replace(',', '.'));
  const reviews = Number(raw.reviews.replace(/[^\d]/g, ''));
  return {
    name: raw.name,
    href: raw.url,
    ...loc,
    address: raw.address.replace(/^Address:\s*/i, '').trim() || null,
    phones: uniq(
      raw.phones.map((p) => normalizePhone(p.replace(/^Phone:\s*/i, ''))).filter((p): p is string => p !== null),
    ),
    website: unwrapGoogleRedirect(raw.website),
    category: raw.category || null,
    rating: Number.isFinite(rating) && rating > 0 ? rating : null,
    reviewCount: reviews > 0 ? reviews : null,
    open24h: raw.open24h ? true : null,
    detailed: true,
  };
}

/** Opens a place page and reads its full details (address, every phone number, website, ...). */
export async function scrapePlace(page: Page, href: string): Promise<GmapsPlace | null> {
  const url = new URL(href);
  url.searchParams.set('hl', 'en');
  await open(page, url.toString());
  const place = await readPlacePage(page);
  // The loaded page's URL can lose the coordinates; trust the ones from the search result.
  const fromHref = parsePlaceHref(href);
  return place && fromHref ? { ...place, ...fromHref } : place;
}
