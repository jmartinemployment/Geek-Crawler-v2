import { shouldExcludeLocalePath } from './locale-path.js';

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

/** Collect http(s) hrefs only — for BFS enqueue + link rows. Does not alter stored body. */
export function extractHrefs($: CheerioLike, pageUrl: string): ExtractedLink[] {
  let pageOriginOk = false;
  try {
    void new URL(pageUrl).origin;
    pageOriginOk = true;
  } catch {
    return [];
  }
  if (!pageOriginOk) return [];

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
      isSameOrigin: isSameSite(pageUrl, linkUrl),
    });
  });

  return out;
}

/** Same-site URLs for BFS enqueue — drops non-US regions and non-English locales. */
export function sameOriginUrls(links: ExtractedLink[]): string[] {
  return links
    .filter((l) => l.isSameOrigin && !shouldExcludeLocalePath(l.linkUrl))
    .map((l) => l.linkUrl);
}
