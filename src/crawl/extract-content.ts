/**
 * Clean article extract for RAG: Readability → Turndown markdown only.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const MAX_MARKDOWN_CHARS = 500_000;

/**
 * Framework-specific link-gallery containers that dwarf a page's real prose
 * (e.g. n8n's /integrations/* directory pages). Verified per-site, not a
 * generic heuristic.
 */
const GALLERY_CONTAINER_SELECTORS = ['.grid:has(a.card--default)'];

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
  excerpt: string | null;
  truncated: boolean;
};

/**
 * Readability-only extract. Miss or throw → nulls (page extraction failure).
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
      return { title: null, markdown: null, excerpt: null, truncated: false };
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        code: 'PAGE_EXTRACT_FAILED',
        url: pageUrl.slice(0, 2000),
        message: message.slice(0, 500),
      }),
    );
    return { title: null, markdown: null, excerpt: null, truncated: false };
  }
}
