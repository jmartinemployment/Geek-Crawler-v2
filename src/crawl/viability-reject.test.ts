/**
 * Challenge / extract-empty → reject classification (no persist path).
 * Run: npx tsx --test src/crawl/viability-reject.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { load } from 'cheerio';
import { extractCleanContent } from './extract-content.js';
import { classifyReject } from './reject.js';
import {
  DEFAULT_JS_ONLY_ABORT_AFTER,
  isViableHtml,
  jsOnlyAbortAfter,
  shouldAbortJsOnly,
} from './viability.js';

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

describe('javascript-only early abort', () => {
  it('lets one page of prose veto the abort, however many shells follow', () => {
    // The safety property. A real site with a handful of SPA routes must never
    // be abandoned, so a single successful extraction disables this for good.
    assert.equal(
      shouldAbortJsOnly({ savedAny: true, shellRejects: 10_000, abortAfter: 25 }),
      false,
    );
  });

  it('stops a site that has produced nothing, at the threshold and not before', () => {
    assert.equal(shouldAbortJsOnly({ savedAny: false, shellRejects: 24, abortAfter: 25 }), false);
    assert.equal(shouldAbortJsOnly({ savedAny: false, shellRejects: 25, abortAfter: 25 }), true);
    assert.equal(shouldAbortJsOnly({ savedAny: false, shellRejects: 26, abortAfter: 25 }), true);
  });

  it('defaults the threshold to 25 and honours the override', () => {
    assert.equal(jsOnlyAbortAfter({} as NodeJS.ProcessEnv), DEFAULT_JS_ONLY_ABORT_AFTER);
    assert.equal(jsOnlyAbortAfter({ JS_ONLY_ABORT_AFTER: '5' } as NodeJS.ProcessEnv), 5);
  });

  it('falls back on nonsense rather than disabling the guard or firing instantly', () => {
    for (const value of ['abc', '0', '-3', '']) {
      assert.equal(
        jsOnlyAbortAfter({ JS_ONLY_ABORT_AFTER: value } as NodeJS.ProcessEnv),
        DEFAULT_JS_ONLY_ABORT_AFTER,
        `JS_ONLY_ABORT_AFTER=${JSON.stringify(value)}`,
      );
    }
  });

  it('counts SPA shells only, never a thin page', () => {
    // The counter is fed by empty_or_spa_shell. If a thin page classified the
    // same way, a slow-loading but perfectly static site would be abandoned.
    assert.equal(isViableHtml(SPA_SHELL, load(SPA_SHELL)).reason, 'empty_or_spa_shell');
    assert.equal(isViableHtml(THIN_PAGE, load(THIN_PAGE)).reason, 'insufficient_text');
  });
});
