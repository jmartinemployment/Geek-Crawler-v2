/**
 * Locale / region path helpers for crawl map + BFS.
 * - Non-English language prefixes → DROP
 * - English language (`en`, `en-us`, …) → STRIP
 * - English-market region prefixes (`us`, `gb`, `uk`, …) → STRIP
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

/**
 * Country/region market prefixes used on English sites (e.g. /us/learn).
 * Stripped so they collapse with the bare path. Overrides language DROP for
 * codes that collide (uk→Ukrainian, sg→Sango, ae→Avestan).
 */
const ENGLISH_MARKET_REGION = new Set([
  'us', // United States
  'gb', // Great Britain
  'uk', // United Kingdom (URL convention; not Ukrainian content here)
  'au', // Australia
  'nz', // New Zealand
  'sg', // Singapore
  'ae', // UAE
]);

function firstPathSegment(pathname: string): string | undefined {
  return pathname.split('/').filter(Boolean)[0];
}

function primaryLang(seg: string): string {
  return seg.toLowerCase().split('-')[0] ?? '';
}

function isEnglishMarketRegionSeg(seg: string): boolean {
  return ENGLISH_MARKET_REGION.has(seg.toLowerCase());
}

function stripLeadingSegment(url: string, shouldStrip: (seg: string) => boolean): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return url;
    if (!shouldStrip(parts[0]!)) return url;
    u.pathname = '/' + parts.slice(1).join('/');
    if (!u.pathname.endsWith('/') && parts.length === 1) {
      u.pathname = '/';
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** True when URL path starts with a non-English locale prefix. */
export function isNonEnglishLocalePath(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const seg = firstPathSegment(pathname);
    if (!seg) return false;
    if (isEnglishMarketRegionSeg(seg)) return false;
    const primary = primaryLang(seg);
    if (primary === 'en') return false;
    return NON_ENGLISH_LOCALE.has(primary);
  } catch {
    return false;
  }
}

/**
 * Strip leading `en` / `en-*` path segment (e.g. /en-us/foo → /foo).
 * Leaves the URL unchanged if there is no English locale prefix.
 */
export function stripEnglishLocalePrefix(url: string): string {
  return stripLeadingSegment(url, (seg) => primaryLang(seg) === 'en');
}

/**
 * Strip leading English-market region segment (e.g. /us/foo → /foo).
 */
export function stripRegionPathPrefix(url: string): string {
  return stripLeadingSegment(url, isEnglishMarketRegionSeg);
}

/**
 * For sitemap map membership:
 * drop non-English languages; strip region (`us`, …) then English (`en`, `en-us`, …).
 * Returns null if the URL should not be on the map.
 */
export function localeNormalizeForMap(url: string): string | null {
  if (isNonEnglishLocalePath(url)) return null;
  return stripEnglishLocalePrefix(stripRegionPathPrefix(url));
}
