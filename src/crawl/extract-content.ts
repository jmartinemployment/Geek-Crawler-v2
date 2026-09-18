/**
 * Deterministic content extract for RAG: strip boilerplate, take the semantic
 * content root, and re-emit the prose as clean semantic HTML.
 *
 * There is no scoring and no candidate selection. Readability was replaced here
 * because it is an *article* extractor, and most of what this crawler fetches --
 * product, pricing, feature and solution pages -- is not an article. Measured
 * against the visible prose of three live pages, Readability returned 9% of
 * freshbooks.com, 44% of taxjar.com and 175% of geekatyourspot.com. Swapping it
 * for another article extractor keeps that failure mode; every library in that
 * space guesses which node holds the article.
 *
 * Guessing is only necessary while boilerplate is still present. Once nav,
 * footer, aside and the landmark roles are removed by selector, the content root
 * is simply the semantic one, and the same three pages measure 101-103%.
 *
 * The output is clean semantic HTML, not Markdown. Markdown marks a block only
 * by a blank line, so block boundaries survive as a whitespace convention that
 * every consumer has to re-infer, and nesting is flattened outright. Emitting
 * `<p>`, `<h2>`, `<li>` keeps the boundary in the data, where the chunker can
 * split on it instead of guessing. Nothing here converts to Markdown, and no
 * Markdown converter is involved: the DOM is walked once and re-emitted.
 */

import { load, type CheerioAPI } from 'cheerio';

/** Cap on the emitted fragment. Whole blocks are dropped, never a partial tag. */
const MAX_CONTENT_CHARS = 500_000;

/**
 * Never corpus, on any site. Removed unconditionally -- no page-type heuristics.
 *
 * `header` is deliberately absent from this list, because sites put the H1 and
 * lede inside it -- removing every `header` deletes the hero. A `header` that
 * *wraps a nav* is navbar chrome rather than content, and is removed separately
 * below; one that does not is left alone.
 */
const BOILERPLATE_SELECTORS =
  'nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], ' +
  // Screen-reader-only text: invisible at every width, and almost always a
  // duplicate of adjacent visible prose or an icon label ("opens in a new
  // window"). `.sr-only` is Bootstrap 4, `.visually-hidden` is Bootstrap 5 and
  // Tailwind. Distinct from `aria-hidden`, which is kept -- that ghost is
  // sometimes the only copy of a headline when the visible one is animated.
  '.sr-only, .visually-hidden';

/**
 * A breakpoint class that turns an element back on above mobile width. Paired
 * with `hidden`, it marks the desktop half of a responsive twin.
 *
 * Matched as class *tokens*, not as a substring: real markup separates them --
 * `class="hidden min-h-screen bg-[#0B162A] lg:block"` -- so a `"hidden lg:"`
 * substring test misses the element entirely and its content is stored twice.
 */
const DESKTOP_DISPLAY_TOKEN =
  /^(sm|md|lg|xl|2xl):(block|flex|grid|inline|inline-block|inline-flex|table|contents|list-item)$/;

/**
 * Bootstrap's spelling of the same thing. Where Tailwind prefixes the
 * breakpoint onto the utility (`lg:block`), Bootstrap infixes it into the
 * display rule (`d-lg-block`), so the Tailwind token above cannot match it and
 * a Bootstrap site's responsive pairs are stored twice.
 *
 * The breakpoint ladder is Bootstrap's own: `xxl`, not Tailwind's `2xl`.
 */
const BOOTSTRAP_DESKTOP_DISPLAY_TOKEN =
  /^d-(sm|md|lg|xl|xxl)-(block|flex|inline|inline-block|inline-flex|grid|inline-grid|table|table-row|table-cell)$/;

/**
 * Desktop-only halves of responsive pairs. A responsive site ships one document
 * and lets CSS choose; with no CSS engine both halves survive and every section
 * is stored twice. Both frameworks encode the breakpoint in the class
 * attribute, so the desktop twin is identifiable without rendering.
 *
 * The test is the same under either convention: hidden at the base width, shown
 * at some larger one. Tailwind writes that `hidden lg:block`, Bootstrap writes
 * it `d-none d-lg-block`.
 *
 * A bare `hidden` or `d-none` with no breakpoint override is deliberately left
 * alone. That element is hidden at every width, which on a JS-free crawl is
 * also how an accordion panel, a tab body and a disclosure section look -- real
 * prose a script would have revealed. Removing the pair is duplicate control;
 * removing the rest would be content loss.
 *
 * This approximates a mobile layout; it does not guarantee one. Only these two
 * class conventions are legible without a CSS engine. A stylesheet that hides a
 * block at `max-width` is invisible to us -- freshbooks.com alone carries 269
 * inline `@media min-width` rules -- as is a bespoke class like taxjar.com's
 * `.hide`. The User-Agent asks for mobile; this prunes what the markup admits
 * to. Anything expressed only in CSS survives.
 */
function isDesktopOnly(className: string | undefined): boolean {
  if (!className) return false;
  const tokens = className.split(/\s+/);
  if (tokens.includes('hidden') && tokens.some((t) => DESKTOP_DISPLAY_TOKEN.test(t))) return true;
  return tokens.includes('d-none') && tokens.some((t) => BOOTSTRAP_DESKTOP_DISPLAY_TOKEN.test(t));
}

/**
 * Framework-specific link-gallery containers that dwarf a page's real prose
 * (e.g. n8n's /integrations/* directory pages). Verified per-site, not a
 * generic heuristic.
 */
const GALLERY_CONTAINER_SELECTORS = ['.grid:has(a.card--default)'];

/** Ordered preference for the content root. Not a fallback chain: one rule. */
const CONTENT_ROOTS = ['main', 'article', '[role="main"]'] as const;

export type ContentRoot = 'main' | 'article' | 'role-main' | 'body';

/**
 * One block of prose, typed. The chunker reads this rather than re-deriving
 * structure from punctuation or blank lines.
 */
/**
 * A link the corpus can cite. Carried as data as well as inline in `html`, so a
 * consumer never has to parse markup to find out where a name points -- and so
 * an embedding target can be plain prose while the citation survives beside it.
 */
export type Anchor = { label: string; href: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; html: string; anchors: Anchor[] }
  | { kind: 'paragraph'; text: string; html: string; anchors: Anchor[] }
  | { kind: 'listItem'; ordered: boolean; text: string; html: string; anchors: Anchor[] }
  | { kind: 'quote'; text: string; html: string; anchors: Anchor[] }
  | { kind: 'code'; text: string; html: string; anchors: Anchor[] }
  | { kind: 'row'; header: boolean; cells: string[]; cellsHtml: string[]; anchors: Anchor[] }
  | { kind: 'term'; text: string; html: string; anchors: Anchor[] }
  | { kind: 'definition'; text: string; html: string; anchors: Anchor[] };

export type CleanContent = {
  title: string | null;
  /** Clean semantic HTML fragment. The corpus body. */
  contentHtml: string | null;
  /** The same content as typed blocks, in document order. */
  blocks: Block[];
  /** Prose only, no tags. What a length or fidelity check must measure. */
  text: string | null;
  excerpt: string | null;
  truncated: boolean;
  /** Which root supplied the content. `body` means the page declared none. */
  contentRoot: ContentRoot | null;
};

function emptyContent(): CleanContent {
  return {
    title: null,
    contentHtml: null,
    blocks: [],
    text: null,
    excerpt: null,
    truncated: false,
    contentRoot: null,
  };
}

/**
 * Elements that end a run of inline text. A `<p>` inside an `<li>` is the
 * common case: both are block level, so the text belongs to the `<p>` alone and
 * counting it for the `<li>` as well is how an extractor stores prose twice.
 */
const BLOCK_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'blockquote',
  'pre',
  'dt',
  'dd',
  'figcaption',
  'address',
  'summary',
  'caption',
  'td',
  'th',
]);

/** Containers handled by their own rule rather than by the generic walk. */
const STRUCTURE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'dl']);

/** A node as the parser hands it over; narrowed structurally to avoid a domhandler import. */
type DomNode = {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
};

function isTagNode(node: DomNode): boolean {
  return node.type === 'tag' && typeof node.name === 'string';
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A run of prose in two forms: the plain text, and the same text with anchors
 * preserved. The corpus needs both. Verification and the length floor measure
 * prose, so they must not see markup; the body has to keep the links, because
 * on a page whose substance is "Top 5 tools: Melio, Dext, Lightyear" the
 * destination of each name *is* the content, and dropping the href leaves a
 * list of words that cite nothing.
 */
type Inline = { text: string; html: string; anchors: Anchor[] };

/** Absolute href, or null when the link is not one the corpus should keep. */
function resolveHref(raw: string | undefined, pageUrl: string): string | null {
  const href = raw?.trim();
  if (!href || href.startsWith('#')) return null;
  if (/^(javascript|mailto|tel|data):/i.test(href)) return null;
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function attr(node: DomNode, name: string): string | undefined {
  const attribs = (node as { attribs?: Record<string, string> }).attribs;
  return attribs?.[name];
}

/**
 * Text belonging to this element and not to a block-level descendant. Stops at
 * every block and structural boundary, so each character is attributed to
 * exactly one block.
 */
function inlineParts(node: DomNode, pageUrl: string): Inline {
  let text = '';
  let html = '';
  const anchors: Anchor[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'text') {
      const data = child.data ?? '';
      text += data;
      html += escapeHtml(data);
      continue;
    }
    if (!isTagNode(child)) continue;
    const name = child.name as string;
    if (name === 'br') {
      // A line break is whitespace. It has no text of its own, so without this
      // the two lines it separates fuse into one word: geekatyourspot.com's
      // `Redefine Your Business<br>…Efficiency` became `BusinessEfficiency`,
      // and that string was the root of every heading path on the site.
      text += ' ';
      html += ' ';
      continue;
    }
    if (BLOCK_TAGS.has(name) || STRUCTURE_TAGS.has(name)) continue;
    const inner = inlineParts(child, pageUrl);
    text += inner.text;
    anchors.push(...inner.anchors);
    if (name === 'a') {
      const href = resolveHref(attr(child, 'href'), pageUrl);
      if (href) {
        const label = collapse(inner.text);
        if (label) anchors.push({ label, href });
        html += `<a href="${escapeHtml(href)}">${inner.html}</a>`;
      } else {
        html += inner.html;
      }
      continue;
    }
    html += inner.html;
  }
  return { text, html, anchors };
}

/**
 * Every character in the subtree, block boundaries included. Used only for table
 * cells: a cell is one unit of corpus, and `visit` does not descend into a row,
 * so a `<td>` wrapping a `<p>` or an `<h3>` would otherwise contribute nothing
 * at all. Measured on taxjar.com's comparison table, that lost four cells.
 */
function deepParts(node: DomNode, pageUrl: string): Inline {
  let text = '';
  let html = '';
  const anchors: Anchor[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'text') {
      const data = child.data ?? '';
      text += data;
      html += escapeHtml(data);
      continue;
    }
    if (!isTagNode(child)) continue;
    if ((child.name as string) === 'br') {
      text += ' ';
      html += ' ';
      continue;
    }
    const inner = deepParts(child, pageUrl);
    text += ' ' + inner.text;
    anchors.push(...inner.anchors);
    if ((child.name as string) === 'a') {
      const href = resolveHref(attr(child, 'href'), pageUrl);
      if (href) {
        const label = collapse(inner.text);
        if (label) anchors.push({ label, href });
        html += ` <a href="${escapeHtml(href)}">${inner.html}</a>`;
      } else {
        html += ' ' + inner.html;
      }
      continue;
    }
    html += ' ' + inner.html;
  }
  return { text, html, anchors };
}

type WalkState = {
  /** Base for resolving relative hrefs; a corpus link has to be followable. */
  pageUrl: string;
  blocks: Block[];
  /** Inline text seen in a generic container, awaiting a boundary. */
  buffer: string;
  /** The same run with its anchors intact. */
  bufferHtml: string;
  /** Anchors seen in that run, as data. */
  bufferAnchors: Anchor[];
  /** Whether the nearest enclosing list is ordered. */
  ordered: boolean;
};

function flushBuffer(state: WalkState): void {
  const text = collapse(state.buffer);
  const html = collapse(state.bufferHtml);
  const anchors = state.bufferAnchors;
  state.buffer = '';
  state.bufferHtml = '';
  state.bufferAnchors = [];
  if (text) state.blocks.push({ kind: 'paragraph', text, html, anchors });
}

function headingLevel(name: string): 1 | 2 | 3 | 4 | 5 | 6 {
  const level = Number(name.slice(1));
  return (level >= 1 && level <= 6 ? level : 6) as 1 | 2 | 3 | 4 | 5 | 6;
}

/** The block a given tag contributes, given its own inline run. */
function blockFor(name: string, inline: Inline, ordered: boolean): Block | null {
  const text = collapse(inline.text);
  if (!text) return null;
  const html = collapse(inline.html);
  const anchors = inline.anchors;
  if (/^h[1-6]$/.test(name)) {
    return { kind: 'heading', level: headingLevel(name), text, html, anchors };
  }
  if (name === 'li') return { kind: 'listItem', ordered, text, html, anchors };
  if (name === 'blockquote') return { kind: 'quote', text, html, anchors };
  if (name === 'pre') return { kind: 'code', text, html, anchors };
  if (name === 'dt') return { kind: 'term', text, html, anchors };
  if (name === 'dd') return { kind: 'definition', text, html, anchors };
  return { kind: 'paragraph', text, html, anchors };
}

/**
 * Descend through a block element looking only for nested *blocks*. Its own
 * inline text has already been taken by `inlineParts`, so text nodes are skipped
 * here; visiting them again is what duplicates a paragraph.
 */
function walkNestedBlocks(node: DomNode, state: WalkState): void {
  for (const child of node.children ?? []) {
    if (!isTagNode(child)) continue;
    const name = child.name as string;
    if (BLOCK_TAGS.has(name) || STRUCTURE_TAGS.has(name)) {
      visit(child, state);
      continue;
    }
    walkNestedBlocks(child, state);
  }
}

/** One table row becomes one block, so a row is never split across chunks. */
function emitRow(node: DomNode, state: WalkState): void {
  const cells: string[] = [];
  const cellsHtml: string[] = [];
  const rowAnchors: Anchor[] = [];
  let header = false;
  for (const child of node.children ?? []) {
    if (!isTagNode(child)) continue;
    const name = child.name as string;
    if (name !== 'td' && name !== 'th') continue;
    if (name === 'th') header = true;
    const parts = deepParts(child, state.pageUrl);
    cells.push(collapse(parts.text));
    cellsHtml.push(collapse(parts.html));
    rowAnchors.push(...parts.anchors);
  }
  if (cells.some((c) => c.length > 0)) {
    state.blocks.push({ kind: 'row', header, cells, cellsHtml, anchors: rowAnchors });
  }
}

function visit(node: DomNode, state: WalkState): void {
  const name = node.name as string;

  if (name === 'tr') {
    flushBuffer(state);
    emitRow(node, state);
    return;
  }

  if (name === 'ul' || name === 'ol') {
    flushBuffer(state);
    const enclosing = state.ordered;
    state.ordered = name === 'ol';
    walkChildren(node, state);
    state.ordered = enclosing;
    return;
  }

  if (STRUCTURE_TAGS.has(name)) {
    flushBuffer(state);
    walkChildren(node, state);
    return;
  }

  if (BLOCK_TAGS.has(name)) {
    flushBuffer(state);
    const block = blockFor(name, inlineParts(node, state.pageUrl), state.ordered);
    if (block) state.blocks.push(block);
    walkNestedBlocks(node, state);
    return;
  }

  walkChildren(node, state);
}

/**
 * Generic containers contribute nothing themselves, but bare text inside a
 * `<div>` is still prose and is buffered until a block boundary claims it.
 */
function walkChildren(node: DomNode, state: WalkState): void {
  for (const child of node.children ?? []) {
    if (child.type === 'text') {
      state.buffer += child.data ?? '';
      state.bufferHtml += escapeHtml(child.data ?? '');
      continue;
    }
    if (!isTagNode(child)) continue;
    const name = child.name as string;
    if (BLOCK_TAGS.has(name) || STRUCTURE_TAGS.has(name)) {
      visit(child, state);
      continue;
    }
    if (name === 'a') {
      // An anchor sitting loose in a container is still a link worth keeping.
      const inner = inlineParts(child, state.pageUrl);
      const href = resolveHref(attr(child, 'href'), state.pageUrl);
      state.buffer += inner.text;
      state.bufferAnchors.push(...inner.anchors);
      if (href) {
        const label = collapse(inner.text);
        if (label) state.bufferAnchors.push({ label, href });
        state.bufferHtml += `<a href="${escapeHtml(href)}">${inner.html}</a>`;
      } else {
        state.bufferHtml += inner.html;
      }
      // A card link wraps its whole card: `<a><h3>..</h3><p>..</p></a>`.
      // inlineParts stopped at those block boundaries, so without this the
      // card's heading and body would be lost entirely.
      walkNestedBlocks(child, state);
      continue;
    }
    walkChildren(child, state);
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escaped on the way out. The payload is HTML now, so an unescaped `Q&A` or
 * `fees < 1%` in a page's own prose would emit a malformed fragment.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/**
 * One emitted element and the blocks it accounts for. A list or a table groups
 * several blocks into a single element, so the two must be tracked together --
 * cutting the block list by a count of emitted elements would misalign them.
 */
type Group = { html: string; blocks: Block[] };

/** Serialise to grouped semantic HTML; consecutive list items and rows merge. */
function serialiseBlocks(blocks: Block[]): Group[] {
  const out: Group[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i] as Block;

    if (block.kind === 'listItem') {
      const ordered = block.ordered;
      const items: string[] = [];
      const consumed: Block[] = [];
      while (i < blocks.length) {
        const next = blocks[i] as Block;
        if (next.kind !== 'listItem' || next.ordered !== ordered) break;
        items.push(`<li>${next.html}</li>`);
        consumed.push(next);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push({ html: `<${tag}>${items.join('')}</${tag}>`, blocks: consumed });
      continue;
    }

    if (block.kind === 'row') {
      const rows: string[] = [];
      const consumed: Block[] = [];
      while (i < blocks.length) {
        const next = blocks[i] as Block;
        if (next.kind !== 'row') break;
        const cell = next.header ? 'th' : 'td';
        rows.push(
          `<tr>${next.cellsHtml.map((c) => `<${cell}>${c}</${cell}>`).join('')}</tr>`,
        );
        consumed.push(next);
        i += 1;
      }
      out.push({ html: `<table>${rows.join('')}</table>`, blocks: consumed });
      continue;
    }

    if (block.kind === 'term' || block.kind === 'definition') {
      const items: string[] = [];
      const consumed: Block[] = [];
      while (i < blocks.length) {
        const next = blocks[i] as Block;
        if (next.kind !== 'term' && next.kind !== 'definition') break;
        items.push(
          next.kind === 'term' ? `<dt>${next.html}</dt>` : `<dd>${next.html}</dd>`,
        );
        consumed.push(next);
        i += 1;
      }
      out.push({ html: `<dl>${items.join('')}</dl>`, blocks: consumed });
      continue;
    }

    let html: string;
    if (block.kind === 'heading') {
      html = `<h${block.level}>${block.html}</h${block.level}>`;
    } else if (block.kind === 'quote') {
      html = `<blockquote><p>${block.html}</p></blockquote>`;
    } else if (block.kind === 'code') {
      html = `<pre><code>${block.html}</code></pre>`;
    } else {
      html = `<p>${block.html}</p>`;
    }
    out.push({ html, blocks: [block] });
    i += 1;
  }
  return out;
}

/**
 * Shorten one block so its serialised element fits the budget. Cutting the
 * prose keeps the tags intact; slicing the serialised HTML instead would leave
 * an unclosed element that no parser can read.
 */
function truncateBlockText(block: Block, budget: number): Block | null {
  if (block.kind === 'row') return null;
  const empty = serialiseBlocks([{ ...block, text: '', html: '' } as Block])[0];
  const room = budget - (empty?.html.length ?? 0);
  if (room <= 0) return null;
  if (block.text.length <= room) return block;
  // Cut to plain prose: slicing markup could sever an anchor mid-tag, and the
  // fragment has to stay parseable above every other consideration.
  const text = block.text.slice(0, room);
  // Anchors are dropped with the markup: one whose label was cut would cite a
  // phrase the fragment no longer contains.
  return { ...block, text, html: escapeHtml(text), anchors: [] } as Block;
}

/** Plain text of a block, for the length and fidelity checks. */
function blockText(block: Block): string {
  return block.kind === 'row' ? block.cells.join(' ') : block.text;
}

/**
 * Title, in descending order of how deliberately the site chose it: the heading
 * on the page, then the social title, then the document title.
 */
function readTitle($: CheerioAPI, blocks: Block[]): string | null {
  // From the blocks, not from the DOM: cheerio's `.text()` would bypass the
  // walk, and then the title disagrees with the prose the corpus actually holds
  // -- a `<br>` in the headline gave `BusinessEfficiency` here while the
  // fragment correctly said `Business Efficiency`.
  const h1 = blocks.find((b) => b.kind === 'heading' && b.level === 1);
  return firstNonEmpty(
    h1 && h1.kind === 'heading' ? h1.text : undefined,
    $('meta[property="og:title"]').attr('content'),
    $('title').first().text(),
  );
}

function readExcerpt($: CheerioAPI, blocks: Block[]): string | null {
  const firstParagraph = blocks.find((b) => b.kind === 'paragraph');
  return firstNonEmpty(
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    firstParagraph && firstParagraph.kind === 'paragraph' ? firstParagraph.text : undefined,
  );
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Extract. Any miss returns nulls -- a page extraction failure, never an
 * exception and never a substituted value.
 */
export function extractCleanContent(html: string, pageUrl: string): CleanContent {
  if (!html || html.length < 40) return emptyContent();

  try {
    const $ = load(html);

    // `img` sits here with `svg` rather than being filtered later, because
    // removal is a DOM decision and this is where the DOM is edited. Measured on
    // freshbooks.com: 24 image nodes, 2,850 chars of markup -- 23% of the
    // extract -- of which twelve were one accordion chevron. A file path is not
    // prose and cannot be a verifiable quote.
    $('script, style, noscript, template, iframe, svg, img, picture').remove();
    // Before the nav itself goes, or there is no nav left to recognise it by.
    // A header built around a nav is site furniture, and the logo and
    // call-to-action sitting outside that nav are furniture too. A header with
    // no nav is a hero and stays.
    $('header').filter((_, el) => $(el).find('nav').length > 0).remove();

    $(BOILERPLATE_SELECTORS).remove();

    $('[class]').filter((_, el) => isDesktopOnly($(el).attr('class'))).remove();

    for (const selector of GALLERY_CONTAINER_SELECTORS) $(selector).remove();

    let contentRoot: ContentRoot = 'body';
    let root = $('body');
    for (const selector of CONTENT_ROOTS) {
      const candidate = $(selector).first();
      if (candidate.length > 0 && (candidate.text() ?? '').trim().length > 0) {
        root = candidate;
        contentRoot = selector === '[role="main"]' ? 'role-main' : (selector as ContentRoot);
        break;
      }
    }

    const rootNode = root.get(0) as unknown as DomNode | undefined;
    if (!rootNode) return emptyContent();

    const state: WalkState = {
      pageUrl,
      blocks: [],
      buffer: '',
      bufferHtml: '',
      bufferAnchors: [],
      ordered: false,
    };
    walkChildren(rootNode, state);
    flushBuffer(state);
    if (state.blocks.length === 0) return emptyContent();

    // Truncation drops whole blocks. Slicing a string of HTML at a byte count
    // would cut inside a tag and emit a fragment no parser can read.
    const groups = serialiseBlocks(state.blocks);
    let contentHtml = groups.map((g) => g.html).join('\n');
    let blocks = state.blocks;
    let truncated = false;
    if (contentHtml.length > MAX_CONTENT_CHARS) {
      // Whole groups only. Blocks and HTML must describe the same content, so
      // the typed list is cut at the same boundary rather than left reporting
      // content the fragment no longer carries.
      truncated = true;
      const keptHtml: string[] = [];
      const keptBlocks: Block[] = [];
      let used = 0;
      for (const group of groups) {
        if (used + group.html.length + 1 > MAX_CONTENT_CHARS) break;
        keptHtml.push(group.html);
        keptBlocks.push(...group.blocks);
        used += group.html.length + 1;
      }
      if (keptHtml.length === 0) {
        // One block larger than the entire budget -- a page whose whole body is
        // a single unbroken run of text. Cut that block's prose rather than
        // return nothing, so an oversized page is still corpus and still
        // reports itself truncated.
        const first = groups[0]?.blocks[0];
        const cut = first ? truncateBlockText(first, MAX_CONTENT_CHARS) : null;
        const group = cut ? serialiseBlocks([cut])[0] : undefined;
        if (cut && group) {
          keptHtml.push(group.html);
          keptBlocks.push(cut);
        }
      }
      contentHtml = keptHtml.join('\n');
      blocks = keptBlocks;
    }
    if (!contentHtml) return emptyContent();

    const text = blocks.map(blockText).filter(Boolean).join('\n');

    return {
      title: readTitle($, blocks),
      contentHtml,
      blocks,
      text: text || null,
      excerpt: readExcerpt($, blocks),
      truncated,
      contentRoot,
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
    return emptyContent();
  }
}
