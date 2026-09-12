/**
 * Three-state reservations + JSONL ledger for handler-plane page dedup.
 * Fail toward duplication, never toward silent loss.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from 'crawlee';
import {
  AliasTable,
  SimhashIndex,
  contentHash,
  crawlDedupKey,
  nearDupConfig,
  simhash64,
  type SimhashEntry,
} from '../crawl/dedup.js';
import { isSameSite } from '../crawl/links.js';

export type HandlerSkipReason =
  | 'duplicate_url'
  | 'duplicate_html'
  | 'canonical_alias'
  | 'duplicate_content'
  | 'near_duplicate';

export type SkipCause = 'accepted' | 'in_flight';

type OwnerOutcome =
  | { outcome: 'committed'; reason: HandlerSkipReason }
  | { outcome: 'released' };

type Slot =
  | { kind: 'accepted'; reason: HandlerSkipReason }
  | {
      kind: 'in_flight';
      settle: Promise<OwnerOutcome>;
      resolve: (o: OwnerOutcome) => void;
    };

export type ReserveResult =
  | { state: 'reserved' }
  | { state: 'accepted'; reason: HandlerSkipReason }
  | { state: 'in_flight'; settled: Promise<OwnerOutcome> };

export type DedupLedgerAccepted = {
  v: 1;
  pageId: string;
  at: string;
  requestedUrlKey: string;
  finalUrlKey: string;
  aliasKeys?: string[];
  canonicalKey?: string;
  htmlHash?: string;
  contentHash?: string;
  simhash?: string;
  markdownLength?: number;
};

export type DedupLedgerSkip = {
  v: 1;
  at: string;
  reason: HandlerSkipReason;
  cause: SkipCause;
  requestedUrl: string;
  finalUrl: string;
  requestedUrlKey?: string;
  finalUrlKey?: string;
  htmlHash?: string;
  contentHash?: string;
  near?: {
    keptUrl: string;
    keptContentHash: string;
    keptMarkdownLength: number;
    keptTitle?: string | null;
    keptCanonicalUrl?: string | null;
    keptExcerpt: string;
    droppedContentHash: string;
    droppedMarkdownLength: number;
    droppedTitle?: string | null;
    droppedExcerpt: string;
    hamming: number;
  };
};

export type DedupCounters = {
  enqueueAttempts: number;
  enqueueSuppressedLocal: number;
  enqueueSuppressedQueue: number;
  httpRequests: number;
  browserRenders: number;
  extractionInvocations: number;
  skippedUrl: number;
  skippedHtml: number;
  skippedCanonicalAlias: number;
  skippedContent: number;
  skippedNearDuplicate: number;
  skipCauseAccepted: number;
  skipCauseInFlight: number;
  aliasesLearned: number;
};

type CheerioRel = {
  (sel: string): {
    attr(name: string): string | undefined;
    each(fn: (i: number, el: unknown) => void): unknown;
  };
};

export type PageDedupTracker = {
  aliases: AliasTable;
  dedupLedgerBackfilled: boolean;
  counters: DedupCounters;
  rehydrate(): Promise<void>;
  resolveKey(url: string): string | null;
  learnRedirect(requestUrl: string, finalUrl: string, scopeUrl: string): void;
  reserve(
    keys: {
      urlKey?: string | null;
      htmlHash?: string | null;
      contentHash?: string | null;
    },
    /** Keys this handler already owns (same turn). */
    owned: Set<string>,
  ): Promise<ReserveResult>;
  awaitInFlight(
    result: ReserveResult,
    boundMs: number,
  ): Promise<{ skip: false } | { skip: true; reason: HandlerSkipReason; cause: SkipCause }>;
  commitAccepted(record: DedupLedgerAccepted): Promise<void>;
  release(keys: {
    urlKey?: string | null;
    htmlHash?: string | null;
    contentHash?: string | null;
  }): void;
  recordSkip(skip: DedupLedgerSkip): Promise<void>;
  registerCanonicalGroup(
    canonicalKey: string,
    representativePageId: string,
    representativeKey: string,
  ): void;
  checkCanonicalAlias(
    pageUrlKey: string,
    declaredCanonicalKey: string | null,
  ): HandlerSkipReason | null;
  checkContentAndNear(input: {
    markdown: string;
    url: string;
    title?: string | null;
    canonicalUrl?: string | null;
  }): Promise<
    | { skip: false; contentHash: string; simhash: string }
    | {
        skip: true;
        reason: 'duplicate_content' | 'near_duplicate';
        contentHash: string;
        simhash: string;
        near?: DedupLedgerSkip['near'];
      }
  >;
  noteContentAccepted(entry: SimhashEntry): void;
  bump(counter: keyof DedupCounters, by?: number): void;
  parseCanonicalHref($: CheerioRel, finalUrl: string, scopeUrl: string): string | null;
};

const NEAR_DUP_MAX_FILES = 200;
const NEAR_DUP_MAX_BYTES = 50 * 1024 * 1024;
const EXCERPT_CHARS = 500;

function emptyCounters(): DedupCounters {
  return {
    enqueueAttempts: 0,
    enqueueSuppressedLocal: 0,
    enqueueSuppressedQueue: 0,
    httpRequests: 0,
    browserRenders: 0,
    extractionInvocations: 0,
    skippedUrl: 0,
    skippedHtml: 0,
    skippedCanonicalAlias: 0,
    skippedContent: 0,
    skippedNearDuplicate: 0,
    skipCauseAccepted: 0,
    skipCauseInFlight: 0,
    aliasesLearned: 0,
  };
}

function bumpSkip(counters: DedupCounters, reason: HandlerSkipReason): void {
  switch (reason) {
    case 'duplicate_url':
      counters.skippedUrl += 1;
      break;
    case 'duplicate_html':
      counters.skippedHtml += 1;
      break;
    case 'canonical_alias':
      counters.skippedCanonicalAlias += 1;
      break;
    case 'duplicate_content':
      counters.skippedContent += 1;
      break;
    case 'near_duplicate':
      counters.skippedNearDuplicate += 1;
      break;
  }
}

function parseJsonlTolerant(raw: string): unknown[] {
  const lines = raw.split('\n');
  const out: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      if (i >= lines.length - 2) break;
    }
  }
  return out;
}

export function createPageDedupTracker(input: {
  dataDir: string;
  runId: string;
}): PageDedupTracker {
  const runDir = path.join(path.resolve(input.dataDir), 'runs', input.runId);
  const acceptedPath = path.join(runDir, 'dedup.jsonl');
  const skipsPath = path.join(runDir, 'dedup-skips.jsonl');
  const nearDupDir = path.join(runDir, 'near-dup-rejected');

  const aliases = new AliasTable();
  const counters = emptyCounters();
  const urlSlots = new Map<string, Slot>();
  const htmlSlots = new Map<string, Slot>();
  const contentSlots = new Map<string, Slot>();
  const canonicalGroups = new Map<
    string,
    { representativePageId: string; representativeKey: string }
  >();
  const cfg = nearDupConfig();
  const simIndex = new SimhashIndex(cfg.hamming);

  let dedupLedgerBackfilled = true;
  let nearDupFiles = 0;
  let nearDupBytes = 0;

  function releaseOne(map: Map<string, Slot>, key: string | null | undefined): void {
    if (!key) return;
    const slot = map.get(key);
    if (!slot || slot.kind !== 'in_flight') return;
    map.delete(key);
    slot.resolve({ outcome: 'released' });
  }

  function commitOne(
    map: Map<string, Slot>,
    key: string | null | undefined,
    reason: HandlerSkipReason,
  ): void {
    if (!key) return;
    const slot = map.get(key);
    if (slot?.kind === 'in_flight') {
      slot.resolve({ outcome: 'committed', reason });
    }
    map.set(key, { kind: 'accepted', reason });
  }

  async function appendJsonl(file: string, row: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
  }

  const tracker: PageDedupTracker = {
    aliases,
    get dedupLedgerBackfilled() {
      return dedupLedgerBackfilled;
    },
    counters,

    async rehydrate() {
      let raw: string | null = null;
      try {
        raw = await readFile(acceptedPath, 'utf8');
      } catch {
        dedupLedgerBackfilled = false;
        log.warning(
          `Dedup ledger missing for run ${input.runId} — resume proceeds without backfill (dedupLedgerBackfilled=false)`,
        );
        return;
      }
      const rows = parseJsonlTolerant(raw) as DedupLedgerAccepted[];
      if (rows.length === 0) {
        dedupLedgerBackfilled = false;
        log.warning(
          `Dedup ledger empty for run ${input.runId} — resume proceeds (dedupLedgerBackfilled=false)`,
        );
        return;
      }
      for (const row of rows) {
        if (!row || row.v !== 1) continue;
        if (row.finalUrlKey) {
          urlSlots.set(row.finalUrlKey, { kind: 'accepted', reason: 'duplicate_url' });
        }
        if (row.requestedUrlKey && row.requestedUrlKey !== row.finalUrlKey) {
          aliases.learn(row.requestedUrlKey, row.finalUrlKey);
        }
        for (const ak of row.aliasKeys ?? []) {
          aliases.learn(ak, row.finalUrlKey);
        }
        if (row.htmlHash) {
          htmlSlots.set(row.htmlHash, { kind: 'accepted', reason: 'duplicate_html' });
        }
        if (row.contentHash) {
          contentSlots.set(row.contentHash, { kind: 'accepted', reason: 'duplicate_content' });
        }
        if (row.canonicalKey) {
          canonicalGroups.set(row.canonicalKey, {
            representativePageId: row.pageId,
            representativeKey: row.finalUrlKey,
          });
        }
        if (row.simhash && row.contentHash) {
          simIndex.add({
            simhash: row.simhash,
            contentHash: row.contentHash,
            pageId: row.pageId,
            url: row.finalUrlKey,
            markdownLength: row.markdownLength ?? 0,
            excerpt: '',
          });
        }
      }
      counters.aliasesLearned = aliases.learned;
      dedupLedgerBackfilled = true;
      log.info(`Dedup ledger rehydrated: ${rows.length} accepted page(s) for ${input.runId}`);
    },

    resolveKey(url) {
      const k = crawlDedupKey(url);
      if (!k) return null;
      return aliases.resolve(k);
    },

    learnRedirect(requestUrl, finalUrl, scopeUrl) {
      if (requestUrl === finalUrl) return;
      if (!isSameSite(scopeUrl, finalUrl) || !isSameSite(scopeUrl, requestUrl)) return;
      const a = crawlDedupKey(requestUrl);
      const b = crawlDedupKey(finalUrl);
      if (!a || !b || a === b) return;
      if (aliases.learn(a, b)) counters.aliasesLearned = aliases.learned;
    },

    async reserve(keys, owned) {
      const checks: Array<{
        map: Map<string, Slot>;
        key: string;
        reason: HandlerSkipReason;
      }> = [];
      if (keys.urlKey) {
        checks.push({ map: urlSlots, key: keys.urlKey, reason: 'duplicate_url' });
      }
      if (keys.htmlHash) {
        checks.push({ map: htmlSlots, key: keys.htmlHash, reason: 'duplicate_html' });
      }
      if (keys.contentHash) {
        checks.push({
          map: contentSlots,
          key: keys.contentHash,
          reason: 'duplicate_content',
        });
      }

      for (const c of checks) {
        const slot = c.map.get(c.key);
        if (slot?.kind === 'accepted') {
          return { state: 'accepted', reason: c.reason };
        }
        if (slot?.kind === 'in_flight' && !owned.has(c.key)) {
          return { state: 'in_flight', settled: slot.settle };
        }
      }

      for (const c of checks) {
        if (!c.map.has(c.key)) {
          let resolve!: (o: OwnerOutcome) => void;
          const settle = new Promise<OwnerOutcome>((r) => {
            resolve = r;
          });
          c.map.set(c.key, { kind: 'in_flight', settle, resolve });
          owned.add(c.key);
        }
      }
      return { state: 'reserved' };
    },

    async awaitInFlight(result, boundMs) {
      if (result.state === 'reserved') return { skip: false };
      if (result.state === 'accepted') {
        counters.skipCauseAccepted += 1;
        return { skip: true, reason: result.reason, cause: 'accepted' };
      }
      const timeout = new Promise<OwnerOutcome>((resolve) => {
        setTimeout(() => resolve({ outcome: 'released' }), Math.max(1, boundMs));
      });
      const outcome = await Promise.race([result.settled, timeout]);
      if (outcome.outcome === 'committed') {
        counters.skipCauseInFlight += 1;
        return { skip: true, reason: outcome.reason, cause: 'in_flight' };
      }
      return { skip: false };
    },

    async commitAccepted(record) {
      commitOne(urlSlots, record.finalUrlKey, 'duplicate_url');
      if (record.requestedUrlKey && record.requestedUrlKey !== record.finalUrlKey) {
        aliases.learn(record.requestedUrlKey, record.finalUrlKey);
      }
      for (const ak of record.aliasKeys ?? []) {
        aliases.learn(ak, record.finalUrlKey);
      }
      commitOne(htmlSlots, record.htmlHash, 'duplicate_html');
      commitOne(contentSlots, record.contentHash, 'duplicate_content');
      if (record.canonicalKey && !canonicalGroups.has(record.canonicalKey)) {
        canonicalGroups.set(record.canonicalKey, {
          representativePageId: record.pageId,
          representativeKey: record.finalUrlKey,
        });
      }
      await appendJsonl(acceptedPath, record);
    },

    release(keys) {
      releaseOne(urlSlots, keys.urlKey);
      releaseOne(htmlSlots, keys.htmlHash);
      releaseOne(contentSlots, keys.contentHash);
    },

    async recordSkip(skip) {
      bumpSkip(counters, skip.reason);
      if (skip.cause === 'accepted') counters.skipCauseAccepted += 1;
      else counters.skipCauseInFlight += 1;
      await appendJsonl(skipsPath, skip);
      log.info(`Dedup skip ${skip.reason} (${skip.cause}): ${skip.finalUrl}`);
    },

    registerCanonicalGroup(canonicalKey, representativePageId, representativeKey) {
      if (!canonicalGroups.has(canonicalKey)) {
        canonicalGroups.set(canonicalKey, { representativePageId, representativeKey });
      }
    },

    checkCanonicalAlias(pageUrlKey, declaredCanonicalKey) {
      if (!declaredCanonicalKey) return null;
      if (pageUrlKey === declaredCanonicalKey) return null;
      if (
        canonicalGroups.has(declaredCanonicalKey) ||
        canonicalGroups.has(pageUrlKey)
      ) {
        return 'canonical_alias';
      }
      return null;
    },

    async checkContentAndNear(meta) {
      const md = meta.markdown;
      const ch = contentHash(md);
      const collapsedLen = md.replace(/\s+/g, ' ').trim().length;
      const sim =
        collapsedLen >= cfg.minChars ? simhash64(md, cfg.shingle) : ch.slice(0, 16);

      const contentSlot = contentSlots.get(ch);
      if (contentSlot?.kind === 'accepted') {
        return { skip: true, reason: 'duplicate_content', contentHash: ch, simhash: sim };
      }

      if (collapsedLen >= cfg.minChars) {
        const near = simIndex.findNear(sim);
        if (near) {
          const droppedExcerpt = md.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
          const nearMeta: DedupLedgerSkip['near'] = {
            keptUrl: near.entry.url,
            keptContentHash: near.entry.contentHash,
            keptMarkdownLength: near.entry.markdownLength,
            keptTitle: near.entry.title,
            keptCanonicalUrl: near.entry.canonicalUrl,
            keptExcerpt: near.entry.excerpt,
            droppedContentHash: ch,
            droppedMarkdownLength: md.length,
            droppedTitle: meta.title,
            droppedExcerpt,
            hamming: near.distance,
          };
          if (nearDupFiles < NEAR_DUP_MAX_FILES && nearDupBytes < NEAR_DUP_MAX_BYTES) {
            try {
              await mkdir(nearDupDir, { recursive: true });
              const file = path.join(nearDupDir, `${ch.slice(0, 24)}.md`);
              const body = md.slice(0, 500_000);
              await writeFile(file, body, 'utf8');
              nearDupFiles += 1;
              nearDupBytes += Buffer.byteLength(body, 'utf8');
            } catch {
              // counter-only
            }
          }
          return {
            skip: true,
            reason: 'near_duplicate',
            contentHash: ch,
            simhash: sim,
            near: nearMeta,
          };
        }
      }

      return { skip: false, contentHash: ch, simhash: sim };
    },

    noteContentAccepted(entry) {
      commitOne(contentSlots, entry.contentHash, 'duplicate_content');
      if (entry.markdownLength >= cfg.minChars) {
        simIndex.add(entry);
      }
    },

    bump(counter, by = 1) {
      counters[counter] += by;
    },

    parseCanonicalHref($, finalUrl, scopeUrl) {
      let href: string | undefined;
      $('link[rel]').each((_, el) => {
        if (href) return;
        const rel = $(el as never).attr('rel')?.toLowerCase() ?? '';
        const tokens = rel.split(/\s+/).filter(Boolean);
        if (!tokens.includes('canonical')) return;
        href = $(el as never).attr('href')?.trim();
      });
      if (!href) return null;
      let abs: URL;
      try {
        abs = new URL(href, finalUrl);
      } catch {
        return null;
      }
      abs.hash = '';
      if (!isSameSite(scopeUrl, abs.toString())) return null;
      return crawlDedupKey(abs.toString());
    },
  };

  return tracker;
}

export { htmlHash } from '../crawl/dedup.js';
