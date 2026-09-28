/**
 * Authoritative ingest size limits.
 *
 * The page limits derive from storage: pages become Mongo documents, so they
 * stay 2 MiB under Mongo's 16 MiB BSON cap. Truncation is prohibited - a page
 * that cannot fit is rejected whole, never trimmed.
 *
 * MAX_LINKS_PER_BATCH is not a Mongo limit. Links go to Postgres through
 * GeekRepository, and 2,000 is the request-size ceiling GeekAPI enforces
 * inline in GeekCrawlerIngestController, rejecting anything larger with "at
 * most 2000 links per batch". There is no GeekCrawlerIngestLimits class on the
 * server; an earlier version of this header claimed to mirror one, and there
 * was nothing on the other side. Nothing keeps the two numbers in step
 * automatically, so raising this constant alone does not raise the server's
 * ceiling - the inline check has to move with it.
 *
 * A page carrying more links than the cap is split by partitionLinkBatches and
 * submitted as several batches. Splitting is not truncating: every row is
 * still sent.
 */

export const MONGO_BSON_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024; // 16_777_216
export const MAX_PAGE_DOCUMENT_BYTES = 14 * 1024 * 1024; // 14_680_064
export const MAX_BATCH_BODY_BYTES = 28 * 1024 * 1024; // 29_360_128
export const MAX_PAGES_PER_BATCH = 100;
export const MAX_LINKS_PER_BATCH = 2_000;

/**
 * Partition rows into batches no larger than MAX_LINKS_PER_BATCH.
 *
 * Every row appears exactly once, in its original order. This exists because
 * one page can carry more links than a single batch may hold: a portal index
 * on netsuite.com produced 5,779 against a cap of 2,000, and the whole crawl
 * failed rather than the batch being split. Splitting is the permitted answer;
 * dropping rows to fit is not.
 */
export function partitionLinkBatches<T>(rows: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < rows.length; start += MAX_LINKS_PER_BATCH) {
    batches.push(rows.slice(start, start + MAX_LINKS_PER_BATCH));
  }
  return batches;
}

const FIXED_DOCUMENT_OVERHEAD_BYTES = 512;
const PER_STRING_FIELD_OVERHEAD_BYTES = 24;

export type PageSizeFields = {
  origin?: string | null;
  url?: string | null;
  finalUrl?: string | null;
  html?: string | null;
  contentHtml?: string | null;
  /**
   * The typed blocks. Counted because they restate the fragment's prose and
   * roughly double the document's content bytes -- a page that fits with
   * contentHtml alone can breach the cap once blocks travel with it.
   */
  blocks?: unknown;
  title?: string | null;
  excerpt?: string | null;
  failureReason?: string | null;
};

export function utf8ByteCount(value: string | null | undefined): number {
  if (!value) return 0;
  return Buffer.byteLength(value, 'utf8');
}

function stringContribution(value: string | null | undefined): number {
  if (!value) return 0;
  return PER_STRING_FIELD_OVERHEAD_BYTES + utf8ByteCount(value);
}

/** Serialised size of the typed blocks, or 0 when none travel. */
function blocksContribution(blocks: unknown): number {
  if (blocks == null) return 0;
  if (Array.isArray(blocks) && blocks.length === 0) return 0;
  return PER_STRING_FIELD_OVERHEAD_BYTES + utf8ByteCount(JSON.stringify(blocks));
}

export function estimatePageDocumentBytes(fields: PageSizeFields): number {
  return (
    FIXED_DOCUMENT_OVERHEAD_BYTES +
    stringContribution(fields.origin) +
    stringContribution(fields.url) +
    stringContribution(fields.finalUrl) +
    stringContribution(fields.html) +
    stringContribution(fields.contentHtml) +
    blocksContribution(fields.blocks) +
    stringContribution(fields.title) +
    stringContribution(fields.excerpt) +
    stringContribution(fields.failureReason)
  );
}

export type HtmlOmitResult = {
  fits: boolean;
  html: string | null;
  estimatedBytes: number;
  htmlOmittedBytes: number;
};

/** Keep HTML when under budget; otherwise omit entirely (never truncate). */
export function applyHtmlOmit(fields: PageSizeFields): HtmlOmitResult {
  const withHtml = estimatePageDocumentBytes(fields);
  if (withHtml <= MAX_PAGE_DOCUMENT_BYTES) {
    return {
      fits: true,
      html: fields.html ?? null,
      estimatedBytes: withHtml,
      htmlOmittedBytes: 0,
    };
  }

  const withoutHtml = estimatePageDocumentBytes({ ...fields, html: null });
  if (withoutHtml <= MAX_PAGE_DOCUMENT_BYTES) {
    return {
      fits: true,
      html: null,
      estimatedBytes: withoutHtml,
      htmlOmittedBytes: utf8ByteCount(fields.html),
    };
  }

  return {
    fits: false,
    html: null,
    estimatedBytes: withoutHtml,
    htmlOmittedBytes: utf8ByteCount(fields.html),
  };
}
