/**
 * Challenge / extract-empty → reject classification (no persist path).
 * Run: npx tsx --test src/crawl/viability-reject.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
  it('classifies empty extract after Readability', () => {
    const clean = extractCleanContent(EMPTY_ARTICLE, 'https://example.com/wp-login.php');
    const reason = classifyReject({
      finalUrl: 'https://example.com/wp-login.php',
      markdown: clean.markdown,
    });
    assert.equal(
      reason,
      'extract_empty',
      `md=${JSON.stringify(clean.markdown)?.slice(0, 120)}`,
    );
  });
});
