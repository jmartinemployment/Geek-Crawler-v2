/**
 * Authoritative ingest size limits.
 *
 * The page limits derive from storage: pages become Mongo documents, so they
 * stay 2 MiB under Mongo's 16 MiB BSON cap. Truncation is prohibited - a page
 * that cannot fit is rejected whole, never trimmed.
 *
 * MAX_LINKS_PER_BATCH is bounded by the request body and nothing else, and the
 * three reasons previously given for it were all wrong. It is not the Mongo BSON
 * cap: links are separate documents, not one document. It is not a Postgres
 * insert ceiling: the crawl store is Mongo end to end and nothing writes crawl
 * data to Postgres. And it is not atomicity: the server's
 * InsertLinksIgnoringDuplicatesAsync loops InsertOneAsync per document and
 * swallows duplicate-key errors one at a time, so a batch of any size is already
 * N independent writes with no rollback. There was never an atomic batch to
 * protect.
 *
 * So the cap is set against MAX_BATCH_BODY_BYTES. The netsuite.com portal page
 * that provoked this carried 5,779 links at roughly 180 bytes each; 10,000 is
 * about 1.8 MiB at that density and 10 MiB even at a pessimistic 1 KiB per link,
 * both well inside the 28 MiB body ceiling. The byte ceiling is enforced too,
 * because a count cap on its own only moves the failure from "too many links" to
 * an unbounded request body.
 *
 * MAX_LINKS_PER_BATCH and MAX_PAGES_PER_BATCH must equal
 * GeekCrawlerIngestLimits.MaxLinksPerBatch and .MaxPagesPerBatch in
 * GeekBackend/GeekAPI/Services/GeekCrawler/GeekCrawlerIngestLimits.cs. That class
 * now exists; an earlier version of this header claimed to mirror one when the
 * server held a bare 2000 inline and there was nothing on the other side.
 * Nothing enforces the match automatically, so raising either number alone
 * rejects large batches at the boundary with a 400 the crawler treats as fatal.
 */

export const MONGO_BSON_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024; // 16_777_216
export const MAX_PAGE_DOCUMENT_BYTES = 14 * 1024 * 1024; // 14_680_064
export const MAX_BATCH_BODY_BYTES = 28 * 1024 * 1024; // 29_360_128
export const MAX_PAGES_PER_BATCH = 100;
export const MAX_LINKS_PER_BATCH = 10_000;



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
