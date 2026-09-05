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

/**
 * First path segment is a non-English locale (e.g. /fr/, /pt-br/).
 * English (`en`, `en-us`, …) and locale-less paths are allowed.
 * Avoids BFS exploding into Zapier-style /fr/templates trees.
 */
const NON_ENGLISH_LOCALE = new Set([
  'aa','ab','ae','af','ak','am','an','ar','as','av','ay','az',
  'ba','be','bg','bh','bi','bm','bn','bo','br','bs',
  'ca','ce','ch','co','cr','cs','cu','cv','cy',
  'da','de','dv','dz',
  'ee','el','eo','es','et','eu',
  'fa','ff','fi','fj','fo','fr','fy',
  'ga','gd','gl','gn','gu','gv',
  'ha','he','hi','ho','hr','ht','hu','hy','hz',
  'ia','id','ie','ig','ii','ik','io','is','it','iu',
  'ja','jv',
  'ka','kg','ki','kj','kk','kl','km','kn','ko','kr','ks','ku','kv','kw','ky',
  'la','lb','lg','li','ln','lo','lt','lu','lv',
  'mg','mh','mi','mk','ml','mn','mr','ms','mt','my',
  'na','nb','nd','ne','ng','nl','nn','no','nr','nv','ny',
  'oc','oj','om','or','os',
  'pa','pi','pl','ps','pt',
  'qu',
  'rm','rn','ro','ru','rw',
  'sa','sc','sd','se','sg','si','sk','sl','sm','sn','so','sq','sr','ss','st','su','sv','sw',
  'ta','te','tg','th','ti','tk','tl','tn','to','tr','ts','tt','tw','ty',
  'ug','uk','ur','uz',
  've','vi','vo',
  'wa','wo',
  'xh',
  'yi','yo',
  'za','zh','zu',
]);

/** True when URL path starts with a non-English locale prefix. */
export function isNonEnglishLocalePath(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const seg = pathname.split('/').filter(Boolean)[0];
    if (!seg) return false;
    const primary = seg.toLowerCase().split('-')[0] ?? '';
    if (primary === 'en') return false;
    return NON_ENGLISH_LOCALE.has(primary);
  } catch {
    return false;
  }
}

/** Same-site URLs for BFS enqueue — drops non-English locale paths. */
export function sameOriginUrls(links: ExtractedLink[]): string[] {
  return links
    .filter((l) => l.isSameOrigin && !isNonEnglishLocalePath(l.linkUrl))
    .map((l) => l.linkUrl);
}
