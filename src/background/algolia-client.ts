// Algolia HN API client. Primary reply-detection path.
//
// Two operations:
//   - searchComments(sinceEpochSec) — one request returns all comments on HN
//     authored since the cutoff. Caller filters by parent_id ∈ monitored.
//   - searchByAuthor(user, sinceEpochSec) — two requests (stories + comments)
//     returning the user's authored items since cutoff. Drives monitored-set
//     population.
//
// Why Algolia over Firebase per-parent polling: see cost-analysis/docs/design.md.
// The sweep at cost-analysis/docs/reports/report.md confirmed 99.99% live
// agreement between Algolia's parent_id filter and Firebase kids[] (minus
// dead/deleted). Algolia excludes dead/deleted by design, which is what we want.

import type { AlgoliaAuthorHit, AlgoliaCommentHit } from '../shared/types.ts';
import { ALGOLIA_API, ALGOLIA_HITS_PER_PAGE, FETCH } from '../shared/constants.ts';
import { log, logErr } from '../shared/debug.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON<T>(url: string, attempt = 0): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH.TIMEOUT_MS);
  const t0 = Date.now();
  log('algolia-client.fetchJSON', `GET attempt=${attempt} url=${url}`);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const body = (await res.json()) as T;
    const elapsed = Date.now() - t0;
    log('algolia-client.fetchJSON', `OK attempt=${attempt} elapsedMs=${elapsed} url=${url}`);
    return body;
  } catch (err) {
    if (attempt >= FETCH.MAX_RETRIES) {
      logErr('algolia-client.fetchJSON', `EXHAUSTED url=${url}`, err);
      throw err;
    }
    const backoff = Math.min(
      FETCH.BACKOFF_BASE_MS * 2 ** attempt,
      FETCH.BACKOFF_MAX_MS,
    );
    log('algolia-client.fetchJSON', `retry attempt=${attempt} backoffMs=${backoff} url=${url}`);
    await sleep(backoff);
    return fetchJSON<T>(url, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}

interface AlgoliaResponse<H> {
  hits: H[];
  nbPages: number;
  page: number;
}

export interface AlgoliaClient {
  searchComments(sinceEpochSec: number): Promise<AlgoliaCommentHit[]>;
  searchByAuthor(user: string, sinceEpochSec: number): Promise<AlgoliaAuthorHit[]>;
  /** Direct comment-children of a parent item (stories or comments).
   *  When `sinceEpochSec` is supplied, Algolia filters replies to those with
   *  `created_at_i > sinceEpochSec`, turning a full reply-history fetch into a
   *  gap-only fetch. Used by the backfill drip worker to catch up on replies
   *  that landed while the extension was offline — the comment-feed poll only
   *  looks back OVERLAP_MS, so longer gaps rely on per-parent sweeps. */
  searchByParent(parentId: number, sinceEpochSec?: number): Promise<AlgoliaCommentHit[]>;
}

export const algoliaClient: AlgoliaClient = {
  async searchComments(sinceEpochSec) {
    const url = `${ALGOLIA_API}/search_by_date?tags=comment&numericFilters=created_at_i%3E${sinceEpochSec}&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}`;
    const data = await fetchJSON<AlgoliaResponse<AlgoliaCommentHit>>(url);
    log('algolia-client.searchComments', `got ${data.hits.length} hits nbPages=${data.nbPages} sinceSec=${sinceEpochSec}`);
    return data.hits;
  },
  async searchByAuthor(user, sinceEpochSec) {
    const tag = `author_${encodeURIComponent(user)}`;
    // Two tag queries, each paginated. First-sync window is DROP_AGE_MS (1y);
    // prolific users (e.g. `dang` ~4k comments/yr) exceed a single 1000-hit
    // page, so truncating would silently miss parents. Cap at MAX_PAGES to
    // bound pathological accounts.
    const MAX_PAGES = 5;
    async function paginate(kind: 'story' | 'comment'): Promise<AlgoliaAuthorHit[]> {
      const out: AlgoliaAuthorHit[] = [];
      let page = 0;
      while (page < MAX_PAGES) {
        // Omit `&page=0` so first-page URLs remain byte-identical to the
        // pre-pagination shape — keeps existing harness tapes valid.
        const pageParam = page === 0 ? '' : `&page=${page}`;
        const url = `${ALGOLIA_API}/search_by_date?tags=${kind},${tag}&numericFilters=created_at_i%3E${sinceEpochSec}&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}${pageParam}`;
        const data = await fetchJSON<AlgoliaResponse<AlgoliaAuthorHit>>(url);
        for (const h of data.hits) out.push(h);
        // IMPORTANT: do NOT trust `nbPages`. Algolia's `search_by_date`
        // endpoint has been observed to report `nbPages=1` even when
        // `nbHits > hitsPerPage` (spot-checked: pjmlp comments hits=1000
        // nbHits=7681 nbPages=1). Stop only when the page is short.
        if (data.hits.length < ALGOLIA_HITS_PER_PAGE) break;
        page++;
        // Same politeness rationale as searchByParent: keep per-parent burst
        // under Algolia's rolling-window tolerance.
        if (page < MAX_PAGES) await sleep(500);
      }
      if (page >= MAX_PAGES - 1) {
        log('algolia-client.searchByAuthor', `MAX_PAGES=${MAX_PAGES} reached user=${user} kind=${kind} — possible truncation`);
      }
      return out;
    }
    const [stories, comments] = await Promise.all([paginate('story'), paginate('comment')]);
    const all = [...stories, ...comments];
    log('algolia-client.searchByAuthor', `user=${user} stories=${stories.length} comments=${comments.length} total=${all.length}`);
    return all;
  },
  async searchByParent(parentId, sinceEpochSec) {
    const out: AlgoliaCommentHit[] = [];
    // `numericFilters` accepts a comma-separated AND-list. When `since` is
    // provided we combine `parent_id=<id>` with `created_at_i>since` so
    // Algolia returns only the relevant slice — making the backfill drip
    // O(new replies) instead of O(all replies).
    const nf = sinceEpochSec !== undefined
      ? `parent_id=${parentId},created_at_i%3E${sinceEpochSec}`
      : `parent_id=${parentId}`;
    // Cap matches searchByAuthor: 5 pages = 5000 hits per parent. A single
    // item with >5000 direct replies is a rounding-error on HN.
    const MAX_PAGES = 5;
    // Inter-page delay. A hot parent with >1000 direct replies would
    // otherwise fire up to 5 sequential fetchJSON calls with no gap,
    // which is fast enough to hit Algolia's per-IP ceiling under load
    // (observed at sustained concurrency in the research sweep). 500ms
    // keeps burst rate ≤ 2 req/s per parent, safely under any rolling
    // window cap we've seen.
    const PAGE_DELAY_MS = 500;
    let page = 0;
    while (page < MAX_PAGES) {
      const pageParam = page === 0 ? '' : `&page=${page}`;
      // search_by_date, NOT search: as of 2026-07 Algolia's relevance index
      // rejects parent_id in numericFilters (400 "attribute not specified in
      // numericAttributesForFiltering"); the by-date index still allows it.
      // Sort order is irrelevant here — we paginate fully and dedupe.
      const url = `${ALGOLIA_API}/search_by_date?tags=comment&numericFilters=${nf}&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}${pageParam}`;
      const data = await fetchJSON<AlgoliaResponse<AlgoliaCommentHit>>(url);
      for (const h of data.hits) out.push(h);
      if (data.hits.length < ALGOLIA_HITS_PER_PAGE) break;
      page++;
      if (page < MAX_PAGES) await sleep(PAGE_DELAY_MS);
    }
    log('algolia-client.searchByParent', `parent=${parentId} sinceSec=${sinceEpochSec ?? 'none'} hits=${out.length}`);
    return out;
  },
};
