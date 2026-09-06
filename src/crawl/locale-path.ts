/**
 * Locale / region path helpers for crawl map + BFS.
 * - KEEP `/us/…` (US market) as-is
 * - DROP other market regions (`/gb/`, `/uk/`, `/au/`, …)
 * - DROP non-English language prefixes (`/fr/`, `/de/`, …)
 * - STRIP English language only (`/en/`, `/en-us/`, …) → bare path
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

/** Allowed market region — keep path as-is. */
const KEEP_REGION = new Set(['us']);

/**
 * Other market / country first segments — drop (dirt).
 * Includes codes that also exist as language tags (uk, sg, ae, …).
 */
const DROP_REGION = new Set([
  'gb', 'uk', 'au', 'nz', 'sg', 'ae',
  'ca', 'ie', 'eu', 'in', 'za', 'jp', 'kr', 'br', 'mx', 'de', 'fr', 'es', 'it', 'nl',
]);

function firstPathSegment(pathname: string): string | undefined {
  return pathname.split('/').filter(Boolean)[0];
}

function primaryLang(seg: string): string {
  return seg.toLowerCase().split('-')[0] ?? '';
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

/** True when first segment is an allowed `/us/` market prefix. */
export function isUsRegionPath(url: string): boolean {
  try {
    const seg = firstPathSegment(new URL(url).pathname);
    return Boolean(seg && KEEP_REGION.has(seg.toLowerCase()));
  } catch {
    return false;
  }
}

/** True when first segment is a non-US market/region prefix to drop. */
export function isDroppedRegionPath(url: string): boolean {
  try {
    const seg = firstPathSegment(new URL(url).pathname);
    if (!seg) return false;
    const lower = seg.toLowerCase();
    if (KEEP_REGION.has(lower)) return false;
    return DROP_REGION.has(lower);
  } catch {
    return false;
  }
}

/** True when URL path starts with a non-English locale prefix (not `/us/`). */
export function isNonEnglishLocalePath(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const seg = firstPathSegment(pathname);
    if (!seg) return false;
    const lower = seg.toLowerCase();
    if (KEEP_REGION.has(lower)) return false;
    const primary = primaryLang(seg);
    if (primary === 'en') return false;
    return NON_ENGLISH_LOCALE.has(primary);
  } catch {
    return false;
  }
}

/** Drop from map / BFS: foreign regions or non-English languages. */
export function shouldExcludeLocalePath(url: string): boolean {
  return isDroppedRegionPath(url) || isNonEnglishLocalePath(url);
}

/**
 * Strip leading `en` / `en-*` path segment (e.g. /en-us/foo → /foo).
 * Does not touch `/us/`.
 */
export function stripEnglishLocalePrefix(url: string): string {
  if (isUsRegionPath(url)) return url;
  return stripLeadingSegment(url, (seg) => primaryLang(seg) === 'en');
}

/**
 * For sitemap map membership:
 * keep `/us/…`; drop other regions + non-English; strip `en` / `en-*` only.
 * Returns null if the URL should not be on the map.
 */
export function localeNormalizeForMap(url: string): string | null {
  if (shouldExcludeLocalePath(url)) return null;
  return stripEnglishLocalePrefix(url);
}
