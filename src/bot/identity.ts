/** Bot contact + default mobile Client Hints (Phase 1 baseline; Phase 2 expands fingerprints). */
export const BOT = {
  name: 'geekatyourspotbot',
  email: 'jeffm@geekatyourspot.com',
  url: 'https://geekatyourspot.com',
} as const;

/**
 * The Chrome major version the UA and Client Hints claim. One constant, because the two must agree
 * and because it has to move: a frozen version reads as an outdated browser, which is what bot
 * firewalls key on. The UA said Chrome/120 (December 2023) until 2026-10-09, when fiscaltec.com
 * answered every fetch 403 "Attention Required" -- Chrome 120 on any device, Android or desktop,
 * with or without the bot headers -- and Chrome 129 or later passed on the same connection. Three
 * crawls fetched one page each, reported no usable pages, and were purged. Set to the Chrome
 * installed on the crawl machine at the time; re-check it when a site starts answering 403 to the
 * seed and 200 to a browser.
 */
export const CHROME_MAJOR = '155';

/**
 * Pixel 7–family UA. Sent on every Cheerio fetch, and set on the one browser context used for link
 * discovery (crawl/link-harvest.ts) so a site sees one identity rather than two.
 *
 * Was "HTTP spoof only; there is no browser in this crawler" until 2026-09-30. There is now exactly
 * one, it loads one page per crawl to read a JavaScript-rendered nav, and it never fetches content.
 */
export const MOBILE_USER_AGENT =
  `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Mobile Safari/537.36`;

export function defaultRequestHeaders(): Record<string, string> {
  return {
    'User-Agent': MOBILE_USER_AGENT,
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': '"Android"',
    'Sec-Ch-Ua': `"Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    From: BOT.email,
    'X-Bot-Name': BOT.name,
    'X-Bot-Url': BOT.url,
  };
}
