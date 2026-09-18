import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCleanContent } from './extract-content.js';

function galleryCard(i: number): string {
  return `<a class="card card--default rounded-small p-6 flex min-h-40" href="/workflows/${i}">Workflow ${i}</a>`;
}

describe('gallery container removal', () => {
  it('strips a large workflow-gallery grid and keeps the prose before it', () => {
    const prose =
      '<h1>If integrations</h1>' +
      '<p>Integrate If with hundreds of other apps using n8n.</p>';
    const gallery =
      '<div class="grid grid gap-8 sm:grid-cols-2 lg:grid-cols-3">' +
      Array.from({ length: 6000 }, (_, i) => galleryCard(i)).join('') +
      '</div>';
    const html = `<html><body><article>${prose}${gallery}</article></body></html>`;

    const result = extractCleanContent(html, 'https://n8n.io/integrations/if/');

    assert.equal(result.truncated, false, 'gallery removal should keep the page under the cap');
    assert.match(result.contentHtml ?? '', /Integrate If with hundreds of other apps/);
    assert.equal(
      (result.contentHtml ?? '').match(/\/workflows\//g)?.length ?? 0,
      0,
      'gallery links must not survive extraction'
    );
  });

  it('is a no-op on pages without the gallery selector', () => {
    const html =
      '<html><body><article><h1>Hi</h1><p>Short article body here.</p></article></body></html>';
    const result = extractCleanContent(html, 'https://n8n.io/a/');

    assert.match(result.contentHtml ?? '', /Short article body here/);
  });
});

describe('boilerplate removal', () => {
  it('removes nav, footer, aside and the landmark roles on every page', () => {
    const html =
      '<html><body>' +
      '<nav><a href="/pricing">Pricing</a><a href="/login">Log in</a></nav>' +
      '<div role="navigation"><a href="/x">Skip</a></div>' +
      '<main><h1>Run payroll</h1><p>The fastest way to pay your team every month.</p></main>' +
      '<aside><p>Related reading you did not ask for.</p></aside>' +
      '<footer><p>Copyright 2026 Example Inc. All rights reserved.</p></footer>' +
      '<div role="contentinfo"><p>Legal small print.</p></div>' +
      '</body></html>';

    const md = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.match(md, /fastest way to pay your team/);
    for (const gone of ['Pricing', 'Log in', 'Skip', 'Related reading', 'All rights reserved', 'Legal small print'])
      assert.equal(md.includes(gone), false, `${gone} must not survive extraction`);
  });

  it('keeps <header> and the H1 inside it', () => {
    // Sites put the hero in <header>; removing it would delete the headline.
    const html =
      '<html><body><header><h1>Redefine Your Business</h1>' +
      '<p>Design, build, and deploy AI systems that fit your existing stack.</p></header>' +
      '<footer><p>All rights reserved.</p></footer></body></html>';

    const out = extractCleanContent(html, 'https://fixture.test/');

    assert.match(out.contentHtml ?? '', /Redefine Your Business/);
    assert.match(out.contentHtml ?? '', /deploy AI systems/);
    assert.equal(out.title, 'Redefine Your Business');
  });
});

describe('image removal', () => {
  it('strips img and picture in the DOM, keeping the prose around them', () => {
    // A file path is not prose and cannot be a verifiable quote. Measured on
    // freshbooks.com this was 2,850 chars, 23% of the extract.
    const html =
      '<html><body><main>' +
      '<p>Send invoices in seconds from any device.</p>' +
      '<img src="/media/chevron-blue-large-up.aef41ed7.svg" alt="Chevron Up">' +
      '<picture><source srcset="/hero.webp"><img src="/hero.png" alt="Dashboard"></picture>' +
      '<p>Get paid twice as fast as with paper billing.</p>' +
      '</main></body></html>';

    const md = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.match(md, /Send invoices in seconds/);
    assert.match(md, /paid twice as fast/);
    assert.equal(md.includes('chevron-blue-large-up'), false, 'image paths must not survive');
    assert.equal(md.includes('hero.png'), false, 'picture sources must not survive');
    assert.equal(md.includes('<img'), false, 'no image element may reach the corpus');
  });
});

describe('mobile-only extraction', () => {
  it('drops the desktop half of a responsive pair and keeps the mobile half', () => {
    const html =
      '<html><body><main>' +
      '<section class="lg:hidden"><h2>Clone Yourself</h2><p>A counterpart that works nonstop for you.</p></section>' +
      '<section class="hidden lg:block"><h2>Clone Yourself</h2><p>A counterpart that works nonstop for you.</p></section>' +
      '</main></body></html>';

    const md = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.equal(
      (md.match(/A counterpart that works nonstop/g) ?? []).length,
      1,
      'a responsive pair must contribute its content exactly once',
    );
  });

  it('drops the desktop half of a Bootstrap responsive pair', () => {
    // Bootstrap infixes the breakpoint -- `d-none d-lg-block` is its spelling of
    // Tailwind's `hidden lg:block`.
    const html =
      '<html><body><main>' +
      '<section class="d-block d-lg-none"><h2>Filing deadlines</h2>' +
      '<p>Quarterly returns are due on the last day of the month.</p></section>' +
      '<section class="d-none d-lg-block"><h2>Filing deadlines</h2>' +
      '<p>Quarterly returns are due on the last day of the month.</p></section>' +
      '</main></body></html>';

    const md = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.equal(
      (md.match(/Quarterly returns are due/g) ?? []).length,
      1,
      'a Bootstrap responsive pair must contribute its content exactly once',
    );
  });

  it('recognises the Bootstrap 5 xxl breakpoint and separated classes', () => {
    const html =
      '<html><body><main>' +
      '<div class="col-12 d-xxl-none"><p>Automate your sales tax compliance today.</p></div>' +
      '<div class="col-12 d-none bg-light d-xxl-flex"><p>Automate your sales tax compliance today.</p></div>' +
      '</main></body></html>';

    const md = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.equal(
      (md.match(/Automate your sales tax compliance/g) ?? []).length,
      1,
      'xxl is Bootstrap\'s top breakpoint and must be recognised',
    );
  });

  it('keeps a bare hidden or d-none element that has no breakpoint override', () => {
    // Hidden at every width. Without JS that is also what a collapsed accordion
    // panel looks like, and its answer text is corpus worth having.
    const html =
      '<html><body><main>' +
      '<div class="hidden"><p>Yes, you can cancel your plan at any time from billing.</p></div>' +
      '<div class="d-none"><p>Refunds are issued within ten business days of request.</p></div>' +
      '</main></body></html>';

    const md = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.match(md, /cancel your plan at any time/);
    assert.match(md, /Refunds are issued within ten business days/);
  });
});

describe('content root', () => {
  it('prefers main, and reports which root was used', () => {
    const html = '<html><body><main><p>Main region content for the page.</p></main></body></html>';
    assert.equal(extractCleanContent(html, 'https://fixture.test/').contentRoot, 'main');
  });

  it('reports body when the page declares no semantic root', () => {
    // Visible, not silent: a body-rooted extract is auditable after the fact.
    const html = '<html><body><div><p>No landmark anywhere on this page at all.</p></div></body></html>';
    const out = extractCleanContent(html, 'https://fixture.test/');
    assert.equal(out.contentRoot, 'body');
    assert.match(out.contentHtml ?? '', /No landmark anywhere/);
  });

  it('returns nulls rather than throwing when there is nothing to extract', () => {
    const out = extractCleanContent('<html><body></body></html>', 'https://fixture.test/');
    assert.equal(out.contentHtml, null);
    assert.equal(out.contentRoot, null);
  });
});

describe('navbar chrome vs hero', () => {
  it('removes a header that wraps a nav, keeps one that does not', () => {
    // Real shape from geekatyourspot.com: a sticky navbar header plus two hero headers.
    const html =
      '<html><body>' +
      '<header class="sticky top-0 z-[60] bg-white shadow-sm">' +
      '<span>GeekAtYourSpot</span><nav aria-label="Site"><a href="/x">Services</a></nav>' +
      '<a href="/book">Book a call</a></header>' +
      '<header class="min-h-screen w-full lg:hidden"><h1>Redefine Your Business</h1>' +
      '<p>Design, build, and deploy AI systems that fit your stack.</p></header>' +
      '</body></html>';

    const md = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.match(md, /Redefine Your Business/);
    for (const chrome of ['GeekAtYourSpot', 'Services', 'Book a call'])
      assert.equal(md.includes(chrome), false, `${chrome} is navbar chrome and must not survive`);
  });

  it('drops a desktop twin whose classes are separated', () => {
    // `hidden` and `lg:block` are not adjacent here, so a substring test misses it
    // and the section is stored twice.
    const html =
      '<html><body><main>' +
      '<section class="w-full min-h-screen lg:hidden"><p>Clone yourself and work around the clock.</p></section>' +
      '<section class="w-full bg-[#023059] min-h-screen hidden lg:block xl:block">' +
      '<p>Clone yourself and work around the clock.</p></section>' +
      '</main></body></html>';

    const md = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.equal(
      (md.match(/Clone yourself and work around the clock/g) ?? []).length,
      1,
      'separated hidden/lg:block classes must still be recognised as the desktop twin',
    );
  });
});

describe('semantic HTML output', () => {
  it('attributes text to one block when a p is nested in an li', () => {
    // Both are block level. Counting the text for the li as well is the classic
    // way an extractor stores every list entry twice.
    const html =
      '<html><body><main><ul><li><p>Unlimited invoices on every plan.</p></li></ul></main></body></html>';

    const out = extractCleanContent(html, 'https://fixture.test/');

    assert.equal(
      ((out.contentHtml ?? '').match(/Unlimited invoices on every plan/g) ?? []).length,
      1,
      'nested block text must be attributed to exactly one block',
    );
  });

  it('collects a nested main/article root once', () => {
    // Selecting `main, article` as a set and searching from both roots yields
    // every node twice on this ordinary markup.
    const html =
      '<html><body><main><article><p>Track every billable hour automatically.</p></article></main></body></html>';

    const out = extractCleanContent(html, 'https://fixture.test/');

    assert.equal(
      ((out.contentHtml ?? '').match(/Track every billable hour/g) ?? []).length,
      1,
      'a nested content root must not double the document',
    );
    assert.equal(out.contentRoot, 'main');
  });

  it('keeps the real heading level rather than flattening every heading', () => {
    const html =
      '<html><body><main>' +
      '<h1>Pricing</h1><h2>Plans</h2><h3>Lite</h3><h4>Add-ons</h4>' +
      '</main></body></html>';

    const html_ = extractCleanContent(html, 'https://fixture.test/').contentHtml ?? '';

    assert.match(html_, /<h1>Pricing<\/h1>/);
    assert.match(html_, /<h2>Plans<\/h2>/);
    assert.match(html_, /<h3>Lite<\/h3>/);
    assert.match(html_, /<h4>Add-ons<\/h4>/);
  });

  it('keeps a short heading', () => {
    // A 25-character floor would delete these, and the heading hierarchy with them.
    const out = extractCleanContent(
      '<html><body><main><h2>Pricing</h2><p>Plans for every stage of growth.</p></main></body></html>',
      'https://fixture.test/',
    );

    assert.match(out.contentHtml ?? '', /<h2>Pricing<\/h2>/);
  });

  it('preserves a pricing table as a table', () => {
    const html =
      '<html><body><main><table>' +
      '<thead><tr><th>Plan</th><th>Price</th></tr></thead>' +
      '<tbody><tr><td>Lite</td><td>$19</td></tr><tr><td>Plus</td><td>$33</td></tr></tbody>' +
      '</table></main></body></html>';

    const out = extractCleanContent(html, 'https://fixture.test/');

    assert.match(out.contentHtml ?? '', /<table><tr><th>Plan<\/th><th>Price<\/th><\/tr>/);
    assert.match(out.contentHtml ?? '', /<tr><td>Lite<\/td><td>\$19<\/td><\/tr>/);
    assert.equal(
      out.blocks.filter((b) => b.kind === 'row').length,
      3,
      'each row is one block so a row is never split across chunks',
    );
  });

  it('keeps a table cell whose content is wrapped in a block element', () => {
    // visit() does not descend into a row, so a cell built from <p>/<h3> -- the
    // shape of taxjar.com's comparison table -- would contribute nothing.
    const html =
      '<html><body><main><table><tr>' +
      '<th><h2>The difference is in the details</h2></th>' +
      '<td><p>Meets requirements</p></td>' +
      '<td><h3>Quality of support</h3></td>' +
      '</tr></table></main></body></html>';

    const out = extractCleanContent(html, 'https://fixture.test/');

    assert.match(out.contentHtml ?? '', /Meets requirements/);
    assert.match(out.contentHtml ?? '', /Quality of support/);
    assert.match(out.contentHtml ?? '', /The difference is in the details/);
    assert.equal(
      ((out.contentHtml ?? '').match(/Meets requirements/g) ?? []).length,
      1,
      'taking the whole cell must not also emit its inner block',
    );
    assert.equal(out.blocks.filter((b) => b.kind === 'row').length, 1);
  });

  it('escapes prose that would otherwise emit malformed HTML', () => {
    const html =
      '<html><body><main><p>Q&amp;A: are fees &lt; 1% of revenue?</p></main></body></html>';

    const out = extractCleanContent(html, 'https://fixture.test/');

    assert.equal(out.contentHtml, '<p>Q&amp;A: are fees &lt; 1% of revenue?</p>');
    assert.equal(out.text, 'Q&A: are fees < 1% of revenue?');
  });

  it('keeps bare text inside a div as a paragraph', () => {
    const out = extractCleanContent(
      '<html><body><main><div>Bookkeeping that keeps itself up to date.</div></main></body></html>',
      'https://fixture.test/',
    );

    assert.equal(out.contentHtml, '<p>Bookkeeping that keeps itself up to date.</p>');
  });

  it('reports blocks and prose text alongside the fragment', () => {
    const html =
      '<html><body><main><h2>Plans</h2><p>Pick a plan.</p>' +
      '<ul><li>Lite</li><li>Plus</li></ul></main></body></html>';

    const out = extractCleanContent(html, 'https://fixture.test/');

    assert.deepEqual(
      out.blocks.map((b) => b.kind),
      ['heading', 'paragraph', 'listItem', 'listItem'],
    );
    assert.match(out.contentHtml ?? '', /<ul><li>Lite<\/li><li>Plus<\/li><\/ul>/);
    assert.equal(out.text, 'Plans\nPick a plan.\nLite\nPlus');
  });

  it('keeps anchors, resolved against the page URL', () => {
    // The shape that matters on geekatyourspot.com: a tool list where the
    // destination of each name is the content, not decoration.
    const html =
      '<html><body><main><p>Top 5 AP tools: ' +
      '<a href="/tools/melio">Melio</a>, ' +
      '<a href="https://dext.com/">Dext</a>, ' +
      '<a href="../lightyear">Lightyear</a>.</p></main></body></html>';

    const out = extractCleanContent(html, 'https://geekatyourspot.com/use-cases/ap/');

    assert.match(out.contentHtml ?? '', /<a href="https:\/\/geekatyourspot\.com\/tools\/melio">Melio<\/a>/);
    assert.match(out.contentHtml ?? '', /<a href="https:\/\/dext\.com\/">Dext<\/a>/);
    assert.match(
      out.contentHtml ?? '',
      /<a href="https:\/\/geekatyourspot\.com\/use-cases\/lightyear">Lightyear<\/a>/,
    );
  });

  it('keeps prose plain so the floor and the hashes never measure markup', () => {
    const out = extractCleanContent(
      '<html><body><main><p>Use <a href="/x">Melio</a> for payments.</p></main></body></html>',
      'https://geekatyourspot.com/',
    );

    assert.equal(out.text, 'Use Melio for payments.');
    assert.equal((out.text ?? '').includes('<'), false, 'prose must carry no markup');
    assert.match(out.contentHtml ?? '', /<a href="https:\/\/geekatyourspot\.com\/x">Melio<\/a>/);
  });

  it('drops a link the corpus cannot follow but keeps its words', () => {
    const out = extractCleanContent(
      '<html><body><main><p>' +
      '<a href="javascript:void(0)">Open menu</a> and ' +
      '<a href="#section">Jump</a> and ' +
      '<a href="mailto:jeff@example.com">Email us</a> today.' +
      '</p></main></body></html>',
      'https://geekatyourspot.com/',
    );

    assert.equal(out.contentHtml, '<p>Open menu and Jump and Email us today.</p>');
    assert.equal(out.text, 'Open menu and Jump and Email us today.');
  });

  it('keeps anchors inside list items and table cells', () => {
    const html =
      '<html><body><main>' +
      '<ul><li><a href="/a">Avalara</a> handles nexus</li></ul>' +
      '<table><tr><td><p><a href="/t">TaxJar</a></p></td></tr></table>' +
      '</main></body></html>';

    const out = extractCleanContent(html, 'https://geekatyourspot.com/');

    assert.match(out.contentHtml ?? '', /<li><a href="https:\/\/geekatyourspot\.com\/a">Avalara<\/a> handles nexus<\/li>/);
    assert.match(out.contentHtml ?? '', /<td><a href="https:\/\/geekatyourspot\.com\/t">TaxJar<\/a><\/td>/);
  });

  it('keeps the contents of a card link that wraps block elements', () => {
    // `<a>` around a whole card is ordinary markup. inlineParts stops at block
    // boundaries, so without walking into it the card's heading and body vanish.
    const html =
      '<html><body><main><a href="/tools/accounting/melio">' +
      '<h3>Melio</h3><p>Pay vendors from one place.</p></a></main></body></html>';

    const out = extractCleanContent(html, 'https://geekatyourspot.com/');

    assert.match(out.contentHtml ?? '', /<h3>Melio<\/h3>/);
    assert.match(out.contentHtml ?? '', /<p>Pay vendors from one place\.<\/p>/);
    assert.deepEqual(
      out.blocks.map((b) => b.kind),
      ['heading', 'paragraph'],
    );
  });

  it('carries anchors as data on the block, not only inside the markup', () => {
    // A consumer building an embedding target needs plain prose and the citation
    // separately; neither should require parsing the fragment to recover.
    const html =
      '<html><body><main><p>Top tools: ' +
      '<a href="/tools/accounting/melio">Melio</a> and ' +
      '<a href="/tools/accounting/dext">Dext</a>.</p></main></body></html>';

    const out = extractCleanContent(html, 'https://geekatyourspot.com/');
    const block = out.blocks[0];

    assert.equal(block?.kind, 'paragraph');
    assert.deepEqual(block?.anchors, [
      { label: 'Melio', href: 'https://geekatyourspot.com/tools/accounting/melio' },
      { label: 'Dext', href: 'https://geekatyourspot.com/tools/accounting/dext' },
    ]);
    assert.equal(block?.text, 'Top tools: Melio and Dext.');
  });

  it('records no anchor for a link the corpus cannot follow', () => {
    const out = extractCleanContent(
      '<html><body><main><p>See <a href="#faq">the FAQ</a> below.</p></main></body></html>',
      'https://geekatyourspot.com/',
    );

    assert.deepEqual(out.blocks[0]?.anchors, []);
    assert.equal(out.blocks[0]?.text, 'See the FAQ below.');
  });

  it('collects anchors from a table row across its cells', () => {
    const html =
      '<html><body><main><table><tr>' +
      '<td><a href="/tools/accounting/bill">BILL</a></td>' +
      '<td><a href="/tools/accounting/ramp">Ramp</a></td>' +
      '</tr></table></main></body></html>';

    const out = extractCleanContent(html, 'https://geekatyourspot.com/');

    assert.deepEqual(
      out.blocks[0]?.anchors.map((a) => a.label),
      ['BILL', 'Ramp'],
    );
  });

  it('truncates an oversized single block instead of returning nothing', () => {
    const html = `<html><body><article>${'word '.repeat(200_000)}</article></body></html>`;

    const out = extractCleanContent(html, 'https://fixture.test/');

    assert.equal(out.truncated, true);
    assert.ok((out.contentHtml ?? '').length <= 500_000);
    assert.match(out.contentHtml ?? '', /^<p>word word/);
    assert.match(out.contentHtml ?? '', /<\/p>$/, 'the cut fragment must still close its tag');
  });
});
