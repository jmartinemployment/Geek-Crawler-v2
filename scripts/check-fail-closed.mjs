#!/usr/bin/env node
/**
 * Fail-closed regression tripwire (not a security boundary).
 * Behavior tests are the real enforcement.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_ROOTS = ['src', 'web/src'];
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', 'my-crawler']);

const BANNED = [
  { id: 'LINK_BATCH_ATTEMPTS', re: /LINK_BATCH_ATTEMPTS/ },
  { id: 'KEEP_LOCAL_DATA', re: /KEEP_LOCAL_DATA/ },
  { id: 'PERSIST_MODE', re: /PERSIST_MODE/ },
  { id: 'playwright-pool import', re: /from ['\"]\.\/playwright-pool/ },
  { id: 'fetchMode playwright', re: /fetchMode:\s*['\"]playwright['\"]/ },
  { id: 'Pages PascalCase ack', re: /result\.Pages\b/ },
  { id: 'Count PascalCase ack', re: /result\.Count\b/ },
  { id: 'env token hub fallback', re: /GEEK_USER_ACCESS_TOKEN|GEEK_ACCESS_TOKEN/ },
  { id: 'local fallback comment', re: /local fallback/i },
];

const ALLOWLIST = [
  { file: 'web/src/app/auth/callback/page.tsx', id: 'Suspense loading' },
  { file: 'web/e2e', id: 'e2e playwright' },
  { file: 'web/playwright.config.ts', id: 'playwright test config' },
];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (EXCLUDE_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(ent.name)) yield full;
  }
}

function allowlisted(rel, banId) {
  return ALLOWLIST.some(
    (a) => (rel === a.file || rel.startsWith(a.file + '/')) && (!a.id || true),
  );
}

const hits = [];
for (const root of SCAN_ROOTS) {
  for await (const file of walk(path.join(ROOT, root))) {
    const rel = path.relative(ROOT, file);
    if (allowlisted(rel)) continue;
    const text = await readFile(file, 'utf8');
    for (const ban of BANNED) {
      if (ban.re.test(text)) {
        if (rel.includes('playwright') && ban.id.includes('playwright')) continue;
        hits.push({ file: rel, pattern: ban.id });
      }
    }
  }
}

if (hits.length) {
  console.error('check-fail-closed failed:');
  for (const h of hits) console.error(`  ${h.file}: ${h.pattern}`);
  process.exit(1);
}
console.log('check-fail-closed ok');
