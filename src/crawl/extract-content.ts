/**
 * Clean article extract for RAG: Readability → Turndown markdown.
 * Keeps crawler HTML intact; this is an additional field for indexing.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const MAX_MARKDOWN_CHARS = 500_000;

export type CleanContent = {
  title: string | null;
  markdown: string | null;
  /** Short plain excerpt from Readability when available. */
  excerpt: string | null;
};

/**
 * Extract main content as markdown. Returns nulls on parse failure (caller still saves HTML).
 */
export function extractCleanContent(html: string, pageUrl: string): CleanContent {
  if (!html || html.length < 40) {
    return { title: null, markdown: null, excerpt: null };
  }

  try {
    const dom = new JSDOM(html, { url: pageUrl });
    const document = dom.window.document;
    const reader = new Readability(document);
    const article = reader.parse();
    if (!article?.content) {
      const main =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;
      if (!main) return { title: null, markdown: null, excerpt: null };
      const title =
        document.querySelector('title')?.textContent?.trim() ||
        document.querySelector('h1')?.textContent?.trim() ||
        null;
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
      });
      let markdown = turndown.turndown(main.innerHTML).trim();
      if (markdown.length > MAX_MARKDOWN_CHARS) {
        markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);
      }
      return {
        title,
        markdown: markdown.length > 0 ? markdown : null,
        excerpt: null,
      };
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    let markdown = turndown.turndown(article.content).trim();
    if (markdown.length > MAX_MARKDOWN_CHARS) {
      markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);
    }

    return {
      title: article.title?.trim() || null,
      markdown: markdown.length > 0 ? markdown : null,
      excerpt: article.excerpt?.trim() || null,
    };
  } catch {
    return { title: null, markdown: null, excerpt: null };
  }
}
