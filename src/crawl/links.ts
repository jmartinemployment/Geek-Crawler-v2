
export type ExtractedLink = {
  linkUrl: string;
  isSameOrigin: boolean;
};

/** Minimal Cheerio-like surface so we avoid CJS/ESM CheerioAPI type clashes. */
type CheerioLike = {
  (selector: string): {
    each(fn: (i: number, el: unknown) => void): unknown;
    attr(name: string): string | undefined;
  };
};

/** Strip leading www. so apex and www count as the same site. */
export function hostnameKey(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

/**
 * Same *site* for crawl BFS: scheme + host without www.
 * Fixes make.com → www.make.com redirects that break strict origin checks.
 */
export function isSameSite(pageUrl: string, linkUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const link = new URL(linkUrl);
    if (page.protocol !== link.protocol) return false;
    return hostnameKey(page.hostname) === hostnameKey(link.hostname);
  } catch {
    return false;
  }
}

/**
 * Collect http(s) hrefs only — for BFS enqueue + link rows. Does not alter stored body.
 *
 * `scopeUrl` anchors the same-site test. Pass the run's seed URL: `pageUrl` is the
 * URL *after* redirects, so anchoring to it lets one off-host redirect move the
 * crawl boundary and the BFS adopts the new host. Required: until 2026-10-06 a
 * missing or unparseable scope quietly became pageUrl, which is that drift.
 * An unparseable page or scope yields no links, and says so.
 */
export function extractHrefs(
  $: CheerioLike,
  pageUrl: string,
  scopeUrl: string,
): ExtractedLink[] {
  for (const [name, value] of [
    ['page', pageUrl],
    ['scope', scopeUrl],
  ] as const) {
    try {
      void new URL(value).origin;
    } catch {
      console.error(
        JSON.stringify({
          code: 'LINK_EXTRACT_UNPARSEABLE_URL',
          which: name,
          url: value.slice(0, 2000),
          pageUrl: pageUrl.slice(0, 2000),
        }),
      );
      return [];
    }
  }
  const scope = scopeUrl;

  const seen = new Set<string>();
  const out: ExtractedLink[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el as never).attr('href')?.trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      return;
    }
    let absolute: URL;
    try {
      absolute = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return;
    absolute.hash = '';
    const linkUrl = absolute.toString();
    if (seen.has(linkUrl)) return;
    seen.add(linkUrl);
    out.push({
      linkUrl,
      isSameOrigin: isSameSite(scope, linkUrl),
    });
  });

  return out;
}

/**
 * Same-site URLs for enqueue.
 *
 * Locale is not filtered here. It was, uncounted, ahead of the counted locale gate in
 * filterEnqueueUrls -- two implementations of one rule, and the one that ran first left no trace in
 * the discovery report. filterEnqueueUrls is now the only locale gate for links.
 */
export function sameOriginUrls(links: ExtractedLink[]): string[] {
  return links.filter((l) => l.isSameOrigin).map((l) => l.linkUrl);
}
