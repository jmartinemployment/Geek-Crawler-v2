/**
 * Authoritative ingest size limits — mirror of GeekAPI GeekCrawlerIngestLimits.
 * Stay 2 MiB under Mongo's 16 MiB BSON cap. Truncation is prohibited.
 */

export const MONGO_BSON_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024; // 16_777_216
export const MAX_PAGE_DOCUMENT_BYTES = 14 * 1024 * 1024; // 14_680_064
export const MAX_BATCH_BODY_BYTES = 28 * 1024 * 1024; // 29_360_128
export const MAX_PAGES_PER_BATCH = 100;
export const MAX_LINKS_PER_BATCH = 2_000;

const FIXED_DOCUMENT_OVERHEAD_BYTES = 512;
const PER_STRING_FIELD_OVERHEAD_BYTES = 24;

export type PageSizeFields = {
  origin?: string | null;
  url?: string | null;
  finalUrl?: string | null;
  html?: string | null;
  markdown?: string | null;
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

export function estimatePageDocumentBytes(fields: PageSizeFields): number {
  return (
    FIXED_DOCUMENT_OVERHEAD_BYTES +
    stringContribution(fields.origin) +
    stringContribution(fields.url) +
    stringContribution(fields.finalUrl) +
    stringContribution(fields.html) +
    stringContribution(fields.markdown) +
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
