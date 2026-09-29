/** Cheap viability check — a non-viable shell becomes an extract_empty reject. */

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


/** Default number of consecutive shell pages before a run is abandoned. */
export const DEFAULT_JS_ONLY_ABORT_AFTER = 25;

export function jsOnlyAbortAfter(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.JS_ONLY_ABORT_AFTER);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_JS_ONLY_ABORT_AFTER;
}

/**
 * Whether a run has seen enough to call the site JavaScript-only.
 *
 * `savedAny` vetoes outright, and that is the whole safety of it: one page
 * carrying prose without JavaScript proves the site is reachable, so a real
 * site with a handful of SPA routes is never abandoned however many shells
 * follow. Only a run that has produced nothing at all can stop early.
 */
export function shouldAbortJsOnly(input: {
  savedAny: boolean;
  shellRejects: number;
  abortAfter: number;
}): boolean {
  if (input.savedAny) return false;
  return input.shellRejects >= input.abortAfter;
}
