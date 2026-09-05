/** Bot contact + default mobile Client Hints (Phase 1 baseline; Phase 2 expands fingerprints). */
export const BOT = {
  name: 'geekatyourspotbot',
  email: 'jeffm@geekatyourspot.com',
  url: 'https://geekatyourspot.com',
} as const;

/** Pixel 7–family UA — HTTP spoof only (no Playwright in Phase 1). */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export function defaultRequestHeaders(): Record<string, string> {
  return {
    'User-Agent': MOBILE_USER_AGENT,
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': '"Android"',
    'Sec-Ch-Ua': '"Chromium";v="120", "Not_A Brand";v="24", "Google Chrome";v="120"',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    From: BOT.email,
    'X-Bot-Name': BOT.name,
    'X-Bot-Url': BOT.url,
  };
}
