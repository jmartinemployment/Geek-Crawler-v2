/**
 * Where a crawl's budget went, read back from the extract cache.
 *
 * The run report counts what was *rejected* — robots, locale, JavaScript, empty
 * extracts. Nothing counted what was *accepted*, so a section quietly consuming
 * a fifth of the page budget looked identical to one consuming a hundredth. That
 * is how 459 en-gb/en-ca/en-au/en-za pages spent 18.8% of a freshbooks crawl
 * twice over without anything flagging it.
 *
 * This reports facts and stops there: pages per section, share of the run, and
 * how much prose those pages carry. It deliberately does not decide that a
 * section is wasteful. A 273-page glossary of 202-character definitions may be
 * exactly the right corpus for one site and budget lost for another, and that
 * call belongs to whoever knows the site — the same reason section-quota.ts
 * calls itself "budget allocation, not content judgement".
 */

import { listCachedPages, readCachedPages } from './extract-cache.js';

/** Below this, a page carries a definition or a stub rather than an argument. */
export const THIN_PROSE_CHARS = 500;

export type SectionSummary = {
  /** First path segment, or `(root)` for the bare path. */
  section: string;
  pages: number;
  /** Fraction of the run's pages, 0..1. */
  shareOfRun: number;
  medianProse: number;
  /** Pages under THIN_PROSE_CHARS. */
  thinPages: number;
};

export type CorpusSummary = {
  runId: string;
  /** Host of the first page read, or null when the run cached nothing. */
  host: string | null;
  pages: number;
  medianProse: number;
  thinPages: number;
  /** Descending by page count — the budget question is "what took the most". */
  sections: SectionSummary[];
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** First path segment, which is the unit section quotas are expressed in. */
function sectionOf(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[0] ?? '(root)';
  } catch {
    return '(root)';
  }
}

/**
 * Summarise one cached run. Null when the run has no cached pages, so a caller
 * can tell "nothing there" from "all sections empty" without a thrown error.
 *
 * Streams the corpus rather than materialising it: a 2,500-page run is hundreds
 * of megabytes of blocks and this has to be runnable on the crawl box.
 */
export async function summarizeCachedRun(
  dataDir: string,
  runId: string,
): Promise<CorpusSummary | null> {
  const metas = await listCachedPages(dataDir, runId);
  if (metas.length === 0) return null;

  let host: string | null = null;
  try {
    host = new URL(metas[0]!.url).hostname;
  } catch {
    host = null;
  }

  const bySection = new Map<string, number[]>();
  const allProse: number[] = [];

  for await (const page of readCachedPages(dataDir, runId)) {
    let prose = 0;
    for (const b of page.blocks) {
      prose += 'text' in b ? b.text.length : b.cells.join(' ').length;
    }
    allProse.push(prose);
    const section = sectionOf(page.url);
    const bucket = bySection.get(section);
    if (bucket) bucket.push(prose);
    else bySection.set(section, [prose]);
  }

  const pages = allProse.length;
  if (pages === 0) return null;

  const sections: SectionSummary[] = [...bySection.entries()]
    .map(([section, prose]) => ({
      section,
      pages: prose.length,
      shareOfRun: prose.length / pages,
      medianProse: median(prose),
      thinPages: prose.filter((p) => p < THIN_PROSE_CHARS).length,
    }))
    .sort((a, b) => b.pages - a.pages || a.section.localeCompare(b.section));

  return {
    runId,
    host,
    pages,
    medianProse: median(allProse),
    thinPages: allProse.filter((p) => p < THIN_PROSE_CHARS).length,
    sections,
  };
}

/** Fixed-width table of a summary, for a terminal. Empty string for no run. */
export function formatCorpusSummary(summary: CorpusSummary | null, topN = 16): string {
  if (!summary) return '';
  const lines: string[] = [];
  lines.push(
    `${summary.host ?? summary.runId.slice(0, 8)} — ${summary.pages} pages, ` +
      `median prose ${summary.medianProse}c, ${summary.thinPages} thin (<${THIN_PROSE_CHARS}c)`,
  );
  lines.push(
    `${'section'.padEnd(26)}${'pages'.padStart(6)}${'share'.padStart(8)}` +
      `${'med prose'.padStart(11)}${'thin'.padStart(7)}`,
  );
  for (const s of summary.sections.slice(0, topN)) {
    lines.push(
      `${s.section.slice(0, 25).padEnd(26)}${String(s.pages).padStart(6)}` +
        `${(100 * s.shareOfRun).toFixed(1).padStart(7)}%${String(s.medianProse).padStart(11)}` +
        `${String(s.thinPages).padStart(7)}`,
    );
  }
  if (summary.sections.length > topN) {
    lines.push(`… ${summary.sections.length - topN} more sections`);
  }
  return lines.join('\n');
}
