/**
 * Stop a crawl that has already proved it will yield nothing.
 *
 * Two sites are out of scope for a static crawler, and both of them were
 * costing a whole crawl to identify. A JavaScript-only site answers every URL
 * with an empty mount point. A site that refuses non-browser clients answers
 * every URL with a 403, a 401, a 429 or a Cloudflare interstitial. In both
 * cases every remaining URL is fetched, rejected, and counted, and the run only
 * reports "no usable pages" once the page budget is spent.
 *
 * One predicate serves both because the rule is the same rule: a run that has
 * produced nothing, and has been told the same thing enough times, stops. Two
 * copies of it would be two thresholds to keep in step and two places for the
 * savedAny veto to be forgotten.
 */

/**
 * Consecutive rejects of one kind before a run that has saved nothing is
 * abandoned.
 *
 * Twenty-five is well past coincidence and well inside the budget. A site with
 * a few broken or gated pages near its entry points is nowhere near it, and a
 * site that is wholly a shell or wholly blocked reaches it in the first wave.
 */
export const DEFAULT_ABORT_AFTER = 25;

/**
 * Read a threshold from the environment, falling back on anything unusable.
 *
 * Nonsense must not disable the guard and must not fire it instantly, so zero,
 * negatives, blanks and non-numbers all land on the default rather than being
 * honoured as written.
 */
export function abortAfterFromEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ABORT_AFTER;
}

/**
 * How many refusals one saved page is allowed to excuse.
 *
 * A working site yields pages faster than it refuses them. This is the rate
 * below which it is not working: fewer than one page saved per ten pages
 * refused means the saves are the exception, not the site.
 */
export const MIN_YIELD_PER_REJECT = 10;

/**
 * Whether a run has seen enough to stop.
 *
 * The first version of this asked whether the run had saved ANY page, and one
 * page vetoed the abort outright. quickbooks.intuit.com on 2026-09-29 is why
 * that is wrong: it refused 2,499 requests with a 403 and let exactly one
 * through, and the single save held the veto open for the entire 2,500-request
 * budget. One page is not a corpus and was never evidence the site works.
 *
 * So the veto is a rate rather than a flag. A site that answers is producing
 * pages at some fraction of the rate it refuses them; a site that is blocking
 * produces a rounding error. Both thresholds must be met to stop: enough
 * refusals to be sure, AND a yield too low to call the site working.
 *
 * A real site with gated sections keeps crawling. 200 saved against 30 refused
 * is nowhere near this, and neither is 3 saved against 25 refused.
 */
export function shouldAbortRun(input: {
  pagesSaved: number;
  rejects: number;
  abortAfter: number;
}): boolean {
  if (input.rejects < input.abortAfter) return false;
  return input.pagesSaved * MIN_YIELD_PER_REJECT < input.rejects;
}

/**
 * Status codes that mean the server refused this client rather than failed.
 *
 * Crawlee's own session pool treats exactly these three as blocked. 404 and 500
 * are deliberately absent: a missing page or a broken one says nothing about
 * whether the site will serve the rest of its URLs, so neither may contribute
 * to abandoning a site.
 */
const BLOCKED_STATUS = new Set([401, 403, 429]);

export function isBlockedStatus(statusCode: number | undefined): boolean {
  return statusCode !== undefined && BLOCKED_STATUS.has(statusCode);
}


/**
 * Pages that produced nothing, by why.
 *
 * One tally rather than one counter per kind, because the question the abort
 * answers is "has this site given us anything", not "has it given us nothing in
 * this particular way". Separate thresholds missed the common case: a site that
 * is part JavaScript shell and part 403 reaches neither of them and crawls out
 * in full, which is exactly the outcome the abort exists to prevent.
 *
 * Three kinds, and the reject reason each is reported as:
 *   shells  -> requires_javascript, a mount point with no content in it
 *   refused -> challenge_page, a 401, 403, 429 or an interstitial
 *   noProse -> extract_empty, a page that parsed but carried no prose
 *
 * Deliberately absent: locale_excluded, non_content_directory and robots_disallowed, which are
 * scope decisions this crawler made rather than answers the site gave; and
 * request_failed, because a DNS error or a timeout says nothing about whether
 * the site would serve its content to a request that arrived.
 */
export type BarrenTally = {
  shells: number;
  refused: number;
  noProse: number;
};

export function emptyBarrenTally(): BarrenTally {
  return { shells: 0, refused: 0, noProse: 0 };
}

export function barrenTotal(tally: BarrenTally): number {
  return tally.shells + tally.refused + tally.noProse;
}

/**
 * Why the run stopped, with the breakdown that says what the site actually did.
 *
 * The post-mortem is the only thing that survives an aborted run, so the
 * sentence has to carry the diagnosis on its own: a wall of shells and a wall
 * of 403s need different answers from the operator.
 */
export function barrenAbortReason(tally: BarrenTally): string {
  const parts = [
    tally.shells > 0 ? `${tally.shells} returned a JavaScript shell` : null,
    tally.refused > 0
      ? `${tally.refused} were refused with a 401, 403, 429 or a challenge page`
      : null,
    tally.noProse > 0 ? `${tally.noProse} parsed but carried no prose` : null,
  ].filter((part): part is string => part !== null);

  return (
    `Nothing extractable after ${barrenTotal(tally)} pages: ${parts.join(', ')}. ` +
    `No page was saved, so the remaining URLs would repeat this. Stopped early.`
  );
}
