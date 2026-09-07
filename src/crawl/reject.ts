/**
 * Unusable-page reject taxonomy — no corpus body persist for these reasons.
 * @see plans/crawl-reject-unusable-pages.md
 */

import { shouldExcludeLocalePath } from './locale-path.js';

export type RejectReason = 'locale_excluded' | 'challenge_page' | 'extract_empty';

const MIN_MARKDOWN_CHARS = Number(process.env.EXTRACT_MIN_MARKDOWN_CHARS ?? 40);
const SAMPLE_CAP = 5;

export type RejectClassifyInput = {
  finalUrl: string;
  /** From isViableHtml when HTML was fetched. */
  viabilityReason?: string;
  /** Set after extractCleanContent; omit to skip extract_empty check. */
  markdown?: string | null;
};

/** Return reject reason, or null if the page may be persisted as corpus. */
export function classifyReject(input: RejectClassifyInput): RejectReason | null {
  if (shouldExcludeLocalePath(input.finalUrl)) {
    return 'locale_excluded';
  }
  if (input.viabilityReason === 'challenge_page') {
    return 'challenge_page';
  }
  if (input.markdown !== undefined && isExtractEmptyMarkdown(input.markdown)) {
    return 'extract_empty';
  }
  return null;
}

export function isExtractEmptyMarkdown(markdown: string | null | undefined): boolean {
  if (markdown == null) return true;
  const trimmed = markdown.trim();
  if (!trimmed) return true;
  return trimmed.length < MIN_MARKDOWN_CHARS;
}

export type RejectCounters = {
  pagesRejectedLocale: number;
  pagesRejectedChallenge: number;
  pagesRejectedExtractEmpty: number;
};

export function emptyRejectCounters(): RejectCounters {
  return {
    pagesRejectedLocale: 0,
    pagesRejectedChallenge: 0,
    pagesRejectedExtractEmpty: 0,
  };
}

export function bumpRejectCounter(counters: RejectCounters, reason: RejectReason): void {
  switch (reason) {
    case 'locale_excluded':
      counters.pagesRejectedLocale += 1;
      break;
    case 'challenge_page':
      counters.pagesRejectedChallenge += 1;
      break;
    case 'extract_empty':
      counters.pagesRejectedExtractEmpty += 1;
      break;
  }
}

/** Cap sample URLs per reject reason for logs / run meta (not HTML). */
export class RejectSampleLog {
  private readonly samples = new Map<RejectReason, string[]>();

  note(reason: RejectReason, url: string): string | null {
    const list = this.samples.get(reason) ?? [];
    if (list.length >= SAMPLE_CAP) return null;
    list.push(url);
    this.samples.set(reason, list);
    return url;
  }

  snapshot(): Record<RejectReason, string[]> {
    return {
      locale_excluded: [...(this.samples.get('locale_excluded') ?? [])],
      challenge_page: [...(this.samples.get('challenge_page') ?? [])],
      extract_empty: [...(this.samples.get('extract_empty') ?? [])],
    };
  }
}

/** Synthetic hostProgressJson entry so GeekAPI can store reject totals without schema change. */
export const REJECT_STATS_ORIGIN = '__crawlee_reject_stats__';

export function rejectStatsHostProgressEntry(
  counters: RejectCounters,
  pagesSaved: number,
): Record<string, unknown> {
  return {
    origin: REJECT_STATS_ORIGIN,
    pagesSaved,
    pagesRejectedLocale: counters.pagesRejectedLocale,
    pagesRejectedChallenge: counters.pagesRejectedChallenge,
    pagesRejectedExtractEmpty: counters.pagesRejectedExtractEmpty,
  };
}
