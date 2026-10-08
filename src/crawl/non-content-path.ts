/**
 * Directories that are never corpus: legal, privacy, terms, cookies, careers.
 *
 * Geek-Crawler-Rag plans/retrieval-from-the-brief.md P7 (2026-10-08). The Tipalti partner crawl of
 * 2026-10-05 held 170 pages, 30 of them under `/legal/` and `/privacy/` -- a services agreement, a
 * customer DPA, a referral agreement, schedule after schedule -- and one of them was returned as
 * evidence for a tool page ("Payments must be calculated, approved, and executed across several
 * currencies and legal entities" matched the agreement's assignment clause). Nothing under these
 * directories is something a page could quote a partner for, and every one of them takes a slot
 * in the index that a product page would have had.
 *
 * Decided on the FIRST path segment only. `/industries/legal/` is a legal-industry solution page
 * (melio.com has one) and stays; `/legal/...` goes. A segment-anchored test, like classify-path,
 * never a substring: "legal" appears inside "legal-entities", which is content.
 */

const NON_CONTENT_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'legal',
  'privacy',
  'privacy-policy',
  'terms',
  'terms-of-service',
  'terms-of-use',
  'terms-and-conditions',
  'cookie-policy',
  'cookies',
  'careers',
  'jobs',
]);

/** The first path segment, lowercased, or null for the homepage or an unparseable URL. */
function firstSegment(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.startsWith('/') ? url : `/${url}`;
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  return segments.length === 0 ? null : segments[0].toLowerCase();
}

/** True when the URL's first path segment is a directory that is never corpus. */
export function shouldExcludeNonContentPath(url: string): boolean {
  const first = firstSegment(url);
  return first !== null && NON_CONTENT_FIRST_SEGMENTS.has(first);
}
