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
    assert.match(result.markdown ?? '', /Integrate If with hundreds of other apps/);
    assert.equal(
      (result.markdown ?? '').match(/\/workflows\//g)?.length ?? 0,
      0,
      'gallery links must not survive extraction'
    );
  });

  it('is a no-op on pages without the gallery selector', () => {
    const html =
      '<html><body><article><h1>Hi</h1><p>Short article body here.</p></article></body></html>';
    const result = extractCleanContent(html, 'https://n8n.io/a/');

    assert.match(result.markdown ?? '', /Short article body here/);
  });
});
