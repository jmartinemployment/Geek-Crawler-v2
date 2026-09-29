/**
 * Challenge / extract-empty → reject classification (no persist path).
 * Run: npx tsx --test src/crawl/viability-reject.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { load } from 'cheerio';
import { extractCleanContent } from './extract-content.js';
import { classifyReject } from './reject.js';
import { isViableHtml } from './viability.js';

const CF_HTML = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body>
<div id="cf-browser-verification"></div>
<p>Attention Required! | Cloudflare</p>
${'x'.repeat(600)}
</body></html>`;

const EMPTY_ARTICLE = `<!DOCTYPE html><html><head><title>Login</title></head>
<body>
<nav>Home About</nav>
<main><form action="/wp-login.php"><label>User</label><input name="log"/><input name="pwd"/><button>Log In</button></form></main>
<footer>© site</footer>
</body></html>`;

describe('challenge fixture', () => {
  it('classifies challenge and would not persist corpus', () => {
    const viability = isViableHtml(CF_HTML);
    assert.equal(viability.viable, false);
    assert.equal(viability.reason, 'challenge_page');
    const reason = classifyReject({
      finalUrl: 'https://example.com/',
      viabilityReason: viability.reason,
    });
    assert.equal(reason, 'challenge_page');
  });
});

describe('extract-empty fixture', () => {
  it('classifies empty extract', () => {
    const clean = extractCleanContent(EMPTY_ARTICLE, 'https://example.com/wp-login.php');
    const reason = classifyReject({
      finalUrl: 'https://example.com/wp-login.php',
      text: clean.text,
    });
    assert.equal(
      reason,
      'extract_empty',
      `md=${JSON.stringify(clean.text)?.slice(0, 120)}`,
    );
  });
});

const PAD = `<div data-pad="${'x'.repeat(600)}"></div>`;

// An SPA shell: the container a framework mounts into, and nothing else.
const SPA_SHELL = `<!DOCTYPE html><html><body><div id="__next"></div>${PAD}</body></html>`;

// Thin but genuinely served: prose, just not much of it. Not a JavaScript
// application, and it must not count toward abandoning the site.
const THIN_PAGE = `<!DOCTYPE html><html><body><main>Short.</main>${PAD}</body></html>`;
describe('shell versus thin page', () => {
  it('classifies an SPA shell apart from a page that is merely short', () => {
    // The early abort counts empty_or_spa_shell and nothing else. If a thin
    // page classified the same way, a small but perfectly static site would be
    // abandoned for having little to say.
    assert.equal(isViableHtml(SPA_SHELL, load(SPA_SHELL)).reason, 'empty_or_spa_shell');
    assert.equal(isViableHtml(THIN_PAGE, load(THIN_PAGE)).reason, 'insufficient_text');
  });
});
