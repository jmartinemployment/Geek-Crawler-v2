/** Cheap viability check — promote non-viable shells to PlaywrightCrawler. */

export type ViabilityResult = {
  viable: boolean;
  reason?: string;
};

const MIN_BYTES = Number(process.env.VIABILITY_MIN_BYTES ?? 512);
const MIN_TEXT_CHARS = Number(process.env.VIABILITY_MIN_TEXT_CHARS ?? 80);

type CheerioLike = {
  (selector: string): {
    text(): string;
    length: number;
  };
};

export function isViableHtml(rawHtml: string, $?: CheerioLike): ViabilityResult {
  if (!rawHtml || rawHtml.length < MIN_BYTES) {
    return { viable: false, reason: 'body_too_small' };
  }

  const lower = rawHtml.toLowerCase();
  if (
    lower.includes('cf-browser-verification') ||
    lower.includes('just a moment...') ||
    lower.includes('attention required! | cloudflare')
  ) {
    return { viable: false, reason: 'challenge_page' };
  }

  if ($) {
    const text = $('main').text() || $('article').text() || $('body').text() || '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length < MIN_TEXT_CHARS) {
      const spaShell = $('#root').length > 0 || $('#__next').length > 0 || $('#app').length > 0;
      if (spaShell || collapsed.length === 0) {
        return { viable: false, reason: 'empty_or_spa_shell' };
      }
      return { viable: false, reason: 'insufficient_text' };
    }
  }

  return { viable: true };
}
