/**
 * Unusable-page reject taxonomy — no corpus body persist for these reasons.
 * @see plans/crawl-reject-unusable-pages.md
 */

import { shouldExcludeLocalePath } from './locale-path.js';

export type RejectReason =
  | 'locale_excluded'
  | 'requires_javascript'
  | 'challenge_page'
  | 'extract_empty'
  | 'robots_disallowed'
  | 'request_failed';

const MIN_TEXT_CHARS = Number(process.env.EXTRACT_MIN_TEXT_CHARS ?? 40);
const SAMPLE_CAP = 5;

export type RejectClassifyInput = {
  finalUrl: string;
  /** From isViableHtml when HTML was fetched. */
  viabilityReason?: string;
  /**
   * Prose only, from extractCleanContent's `text`; omit to skip the
   * extract_empty check. Deliberately not the emitted HTML: measuring the
   * fragment would count tag bytes as content, and a page carrying nothing but
   * markup would clear the floor with no prose in it at all.
   */
  text?: string | null;
};

/** Return reject reason, or null if the page may be persisted as corpus. */
export function classifyReject(input: RejectClassifyInput): RejectReason | null {
  if (shouldExcludeLocalePath(input.finalUrl)) {
    return 'locale_excluded';
  }
  if (input.viabilityReason === 'challenge_page') {
    return 'challenge_page';
  }
  if (input.text !== undefined && isExtractEmptyText(input.text)) {
    return 'extract_empty';
  }
  return null;
}

export function isExtractEmptyText(text: string | null | undefined): boolean {
  if (text == null) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return trimmed.length < MIN_TEXT_CHARS;
}

export type RejectCounters = {
  pagesRejectedLocale: number;
  /**
   * The page needs a browser to say anything. Not a failure: this crawler
   * executes no JavaScript by design, so such a page is out of scope the same
   * way a robots-disallowed URL is.
   */
  pagesRejectedRequiresJavascript: number;
  pagesRejectedChallenge: number;
  pagesRejectedExtractEmpty: number;
  pagesRejectedRobots: number;
  pagesRejectedRequestFailed: number;
};

export function emptyRejectCounters(): RejectCounters {
  return {
    pagesRejectedLocale: 0,
    pagesRejectedRequiresJavascript: 0,
    pagesRejectedChallenge: 0,
    pagesRejectedExtractEmpty: 0,
    pagesRejectedRobots: 0,
    pagesRejectedRequestFailed: 0,
  };
}

export function bumpRejectCounter(counters: RejectCounters, reason: RejectReason): void {
  switch (reason) {
    case 'locale_excluded':
      counters.pagesRejectedLocale += 1;
      break;
    case 'requires_javascript':
      counters.pagesRejectedRequiresJavascript += 1;
      break;
    case 'challenge_page':
      counters.pagesRejectedChallenge += 1;
      break;
    case 'extract_empty':
      counters.pagesRejectedExtractEmpty += 1;
      break;
    case 'robots_disallowed':
      counters.pagesRejectedRobots += 1;
      break;
    case 'request_failed':
      counters.pagesRejectedRequestFailed += 1;
      break;
  }
}

export type RejectSample = {
  url: string;
  detail?: string;
};

function sanitizeSampleUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.split(/[?#]/, 1)[0].slice(0, 500);
  }
}

export function sanitizeRejectDetail(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(
      /\b(authorization|api[-_ ]?key|token|password)\b\s*[:=]\s*\S+/gi,
      '$1=[REDACTED]',
    )
    .trim()
    .slice(0, 300);
}

/** Cap sample URLs per reject reason for logs / run meta (not HTML). */
export class RejectSampleLog {
  private readonly samples = new Map<RejectReason, RejectSample[]>();

  note(reason: RejectReason, url: string, detail?: string): RejectSample | null {
    const list = this.samples.get(reason) ?? [];
    if (list.length >= SAMPLE_CAP) return null;
    const sample = {
      url: sanitizeSampleUrl(url),
      ...(sanitizeRejectDetail(detail)
        ? { detail: sanitizeRejectDetail(detail) }
        : {}),
    };
    list.push(sample);
    this.samples.set(reason, list);
    return sample;
  }

  /**
   * Only reasons that actually fired. Emitting every key with an empty array
   * made a report claim five reject categories for a site that hit none of
   * them — a reader listing the keys cannot tell "no pages hit this" from
   * "pages hit this", and the empty ones are indistinguishable from real
   * findings.
   */
  snapshot(): Partial<Record<RejectReason, RejectSample[]>> {
    const out: Partial<Record<RejectReason, RejectSample[]>> = {};
    for (const [reason, list] of this.samples) {
      if (list.length > 0) out[reason] = [...list];
    }
    return out;
  }
}

/** Synthetic hostProgressJson entry so GeekAPI can store reject totals without schema change. */
export const REJECT_STATS_ORIGIN = '__crawlee_reject_stats__';

export function rejectStatsHostProgressEntry(
  counters: RejectCounters,
  pagesSaved: number,
  rejectSamples?: Partial<Record<RejectReason, RejectSample[]>>,
  dedup?: Record<string, number | boolean>,
): Record<string, unknown> {
  return {
    origin: REJECT_STATS_ORIGIN,
    pagesSaved,
    pagesRejectedLocale: counters.pagesRejectedLocale,
    pagesRejectedRequiresJavascript: counters.pagesRejectedRequiresJavascript,
    pagesRejectedChallenge: counters.pagesRejectedChallenge,
    pagesRejectedExtractEmpty: counters.pagesRejectedExtractEmpty,
    pagesRejectedRobots: counters.pagesRejectedRobots,
    pagesRejectedRequestFailed: counters.pagesRejectedRequestFailed,
    ...(rejectSamples ? { rejectSamples } : {}),
    ...(dedup ?? {}),
  };
}
