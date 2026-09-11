/**
 * Clean article extract for RAG: Readability → Turndown markdown.
 * Keeps crawler HTML intact; this is an additional field for indexing.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const MAX_MARKDOWN_CHARS = 500_000;

/**
 * Framework-specific link-gallery containers that dwarf a page's real prose
 * (e.g. n8n's /integrations/* directory pages: 5,857 workflow cards vs a few
 * paragraphs of node description). Verified per-site, not a generic heuristic
 * — see plans/oversized-directory-page-extraction.md. Add an entry per site
 * family encountered; do not widen these into a generic density rule.
 */
const GALLERY_CONTAINER_SELECTORS = ['.grid:has(a.card--default)'];

/** Strip known gallery containers before Readability scores the document. */
function stripGalleryContainers(document: Document): void {
  for (const selector of GALLERY_CONTAINER_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      el.remove();
    }
  }
}

export type CleanContent = {
  title: string | null;
  markdown: string | null;
  /** Short plain excerpt from Readability when available. */
  excerpt: string | null;
  /**
   * True when markdown hit MAX_MARKDOWN_CHARS and was cut. Truncated pages were
   * previously indistinguishable from complete ones, so oversized pages were
   * indexed as though whole. They are also the pages most likely to exhaust
   * requestHandlerTimeoutSecs and be retried.
   */
  truncated: boolean;
};

/**
 * Extract main content as markdown. Returns nulls on parse failure (caller still saves HTML).
 */
export function extractCleanContent(html: string, pageUrl: string): CleanContent {
  if (!html || html.length < 40) {
    return { title: null, markdown: null, excerpt: null, truncated: false };
  }

  try {
    const dom = new JSDOM(html, { url: pageUrl });
    const document = dom.window.document;
    stripGalleryContainers(document);
    const reader = new Readability(document);
    const article = reader.parse();
    if (!article?.content) {
      // Fallback: try body text via turndown of main/article if present
      const main =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;
      if (!main) return { title: null, markdown: null, excerpt: null, truncated: false };
      const title =
        document.querySelector('title')?.textContent?.trim() ||
        document.querySelector('h1')?.textContent?.trim() ||
        null;
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
      });
      let markdown = turndown.turndown(main.innerHTML).trim();
      let truncated = false;
      if (markdown.length > MAX_MARKDOWN_CHARS) {
        markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);
        truncated = true;
      }
      return {
        title,
        markdown: markdown.length > 0 ? markdown : null,
        excerpt: null,
        truncated,
      };
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    let markdown = turndown.turndown(article.content).trim();
    let truncated = false;
    if (markdown.length > MAX_MARKDOWN_CHARS) {
      markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);
      truncated = true;
    }

    return {
      title: article.title?.trim() || null,
      markdown: markdown.length > 0 ? markdown : null,
      excerpt: article.excerpt?.trim() || null,
      truncated,
    };
  } catch {
    return { title: null, markdown: null, excerpt: null, truncated: false };
  }
}
