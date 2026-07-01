// Stage 2 full retrospective sweep — samples ~20k parents stratified across
// 180 days, computes direct-reply counts at 8 age windows, and cross-checks
// every parent against Firebase kids[] (filtering dead/deleted, which Algolia
// excludes by design — smoke-02 established this explains 100% of the raw gap).
//
// Run: node cost-analysis/scripts/sweep.mjs --label=full-01
//
// Writes cost-analysis/data/<label>/sweep.jsonl incrementally as parents
// complete, so process interruption doesn't lose work. summary.json written
// at the end.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchWithBackoff,
  getStats,
  makeBudget,
  resetStats,
  runConcurrent,
  sleep,
} from './lib/http.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const label = args.label;
if (!label) {
  console.error('usage: sweep.mjs --label=<name> [--parents=20000] [--concurrency=14] [--age-days=180] [--types=story,comment]');
  process.exit(1);
}
const totalParents = Number.parseInt(args.parents ?? '20000', 10);
const concurrency = Number.parseInt(args.concurrency ?? '14', 10);
const ageDays = Number.parseInt(args['age-days'] ?? '180', 10);
const types = (args.types ?? 'story,comment').split(',');
const BUCKETS = Number.parseInt(args.buckets ?? '12', 10);

const OUT = join(process.cwd(), 'cost-analysis', 'data', label);
mkdirSync(OUT, { recursive: true });

const SWEEP_PATH = join(OUT, 'sweep.jsonl');
const CROSS_PATH = join(OUT, 'crosscheck.jsonl');
writeFileSync(SWEEP_PATH, ''); // truncate
writeFileSync(CROSS_PATH, '');

const WINDOWS_SEC = {
  '30m': 30 * 60,
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '2w': 14 * 24 * 60 * 60,
  '1m': 30 * 24 * 60 * 60,
  '3m': 90 * 24 * 60 * 60,
};

const ALGOLIA = 'https://hn.algolia.com/api/v1';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

function log(msg) {
  const t = new Date().toISOString();
  console.log(`${t} [sweep] ${msg}`);
}

async function sampleStratified(type, totalN, ageDaysRange, buckets) {
  const bucketDaysEach = ageDaysRange / buckets;
  const perBucket = Math.ceil(totalN / buckets);
  const nowSec = Math.floor(Date.now() / 1000);
  const all = [];
  for (let b = 0; b < buckets; b++) {
    const bEnd = nowSec - Math.floor(b * bucketDaysEach * 86400);
    const bStart = nowSec - Math.floor((b + 1) * bucketDaysEach * 86400);
    const fetched = [];
    let page = 0;
    while (fetched.length < perBucket && page < 10) {
      const url = `${ALGOLIA}/search_by_date?tags=${type}&numericFilters=created_at_i<${bEnd},created_at_i>=${bStart}&hitsPerPage=1000&page=${page}`;
      const res = await fetchWithBackoff(url);
      const data = await res.json();
      if (!data.hits?.length) break;
      fetched.push(...data.hits);
      if (data.hits.length < 1000) break;
      page++;
    }
    all.push(...fetched.slice(0, perBucket));
    log(`  sample ${type} bucket ${b + 1}/${buckets} (age ${(b * bucketDaysEach).toFixed(1)}-${((b + 1) * bucketDaysEach).toFixed(1)}d): got ${fetched.length}`);
  }
  return all;
}

async function fetchDirectChildren(parentId) {
  const out = [];
  let page = 0;
  while (true) {
    const url = `${ALGOLIA}/search_by_date?tags=comment&numericFilters=parent_id=${parentId}&hitsPerPage=1000&page=${page}`;
    const res = await fetchWithBackoff(url);
    const data = await res.json();
    for (const h of data.hits) out.push(h);
    if (data.hits.length < 1000 || page >= (data.nbPages ?? 1) - 1) break;
    page++;
  }
  return out;
}

async function fetchFirebaseKidsRaw(parentId) {
  const url = `${FIREBASE}/item/${parentId}.json`;
  const res = await fetchWithBackoff(url);
  const data = await res.json();
  return (data?.kids ?? []).map(String);
}

async function classifyKid(kidId) {
  const url = `${FIREBASE}/item/${kidId}.json`;
  const res = await fetchWithBackoff(url);
  const data = await res.json();
  return { id: String(kidId), dead: !!data?.dead, deleted: !!data?.deleted };
}

function bucketize(parentCreatedAt, children, parentAgeSec) {
  const counts = {};
  for (const [k, ws] of Object.entries(WINDOWS_SEC)) {
    counts[k] = parentAgeSec >= ws ? 0 : null; // null = window incomplete for this parent's age
  }
  for (const c of children) {
    const age = c.created_at_i - parentCreatedAt;
    if (age < 0) continue;
    for (const [k, ws] of Object.entries(WINDOWS_SEC)) {
      if (counts[k] !== null && age <= ws) counts[k]++;
    }
  }
  return counts;
}

async function main() {
  resetStats();
  const budget = makeBudget({ walltimeMs: 90 * 60 * 1000, requestCap: 90000 });
  const nowSec = Math.floor(Date.now() / 1000);

  log(`label=${label} parents=${totalParents} concurrency=${concurrency} ageDays=${ageDays} types=${types.join(',')}`);
  log(`out=${OUT}`);

  // Stage 2a: sample parents per type, stratified by age bucket.
  const perTypeN = Math.floor(totalParents / types.length);
  const parentHits = [];
  for (const t of types) {
    log(`sampling ${perTypeN} ${t} parents across ${ageDays}d (${BUCKETS} buckets)...`);
    const sampled = await sampleStratified(t, perTypeN, ageDays, BUCKETS);
    log(`  ${t}: sampled ${sampled.length}`);
    for (const p of sampled) parentHits.push({ ...p, _type: t });
  }
  log(`total parents sampled: ${parentHits.length}`);

  // Stage 2b: for each parent, fetch direct children + crosscheck.
  let done = 0;
  let writtenSweep = 0;
  let writtenCross = 0;

  const perParent = async (p) => {
    if (budget.exhausted()) throw new Error('budget exhausted');
    const children = await fetchDirectChildren(p.objectID);
    const ids = children.map((c) => String(c.objectID));
    const parentAgeSec = nowSec - p.created_at_i;

    const row = {
      parent_id: String(p.objectID),
      parent_type: p._type,
      author: p.author,
      created_at_i: p.created_at_i,
      parent_age_sec: parentAgeSec,
      points: p.points ?? null,
      num_comments_algolia_field: p.num_comments ?? null,
      direct_children_count: children.length,
      direct_children_ids: ids,
      window_counts: bucketize(p.created_at_i, children, parentAgeSec),
    };

    // Crosscheck against Firebase (100% of parents).
    const fbKidsRaw = await fetchFirebaseKidsRaw(p.objectID);
    const fbSetRaw = new Set(fbKidsRaw);
    const algSet = new Set(ids);
    const fbOnlyRaw = [...fbSetRaw].filter((x) => !algSet.has(x));
    const algOnly = [...algSet].filter((x) => !fbSetRaw.has(x));
    const intersect = [...algSet].filter((x) => fbSetRaw.has(x)).length;

    let fbOnlyDead = 0;
    let fbOnlyLive = 0;
    if (fbOnlyRaw.length > 0) {
      const classes = await runConcurrent(fbOnlyRaw.map((id) => () => classifyKid(id)), 8);
      for (const r of classes) {
        if (!r.ok) continue;
        if (r.value.dead || r.value.deleted) fbOnlyDead++;
        else fbOnlyLive++;
      }
    }

    const cross = {
      parent_id: String(p.objectID),
      parent_type: p._type,
      algolia_count: algSet.size,
      firebase_raw_count: fbSetRaw.size,
      firebase_live_count: fbSetRaw.size - fbOnlyDead,
      intersect,
      algolia_only: algOnly.length,
      firebase_only_raw: fbOnlyRaw.length,
      firebase_only_dead_or_deleted: fbOnlyDead,
      firebase_only_live: fbOnlyLive,
    };

    return { row, cross };
  };

  // Process all parents concurrently, but write results as they arrive.
  const queue = parentHits.slice();
  let next = 0;
  const failures = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= queue.length) return;
        if (budget.exhausted()) {
          failures.push({ parent_id: String(queue[i].objectID), error: 'budget_exhausted_before_attempt' });
          continue;
        }
        try {
          const { row, cross } = await perParent(queue[i]);
          appendFileSync(SWEEP_PATH, JSON.stringify(row) + '\n');
          appendFileSync(CROSS_PATH, JSON.stringify(cross) + '\n');
          writtenSweep++;
          writtenCross++;
        } catch (err) {
          failures.push({ parent_id: String(queue[i].objectID), error: String(err?.message || err) });
        } finally {
          done++;
          if (done % 500 === 0) {
            const stats = getStats();
            log(`progress: ${done}/${queue.length} failures=${failures.length} reqs=${stats.requests} throttles=${stats.throttles.length}`);
          }
        }
      }
    }),
  );

  const stats = getStats();
  const summary = {
    label,
    stage: 'full',
    started_at: new Date(budget.startAt).toISOString(),
    finished_at: new Date().toISOString(),
    wall_ms: Date.now() - budget.startAt,
    inputs: { totalParents, concurrency, ageDays, types, buckets: BUCKETS },
    parents_sampled: parentHits.length,
    parents_written: writtenSweep,
    failures_count: failures.length,
    failures_sample: failures.slice(0, 20),
    total_requests: stats.requests,
    throttles_count: stats.throttles.length,
    throttles_sample: stats.throttles.slice(0, 20),
    errors_count: stats.errors.length,
    errors_sample: stats.errors.slice(0, 20),
    budget_exhausted: budget.exhausted(),
  };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT, 'failures.jsonl'), failures.map((f) => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''));

  log(`---`);
  log(`done: ${writtenSweep}/${parentHits.length} parents written, failures=${failures.length}`);
  log(`requests=${stats.requests} throttles=${stats.throttles.length} errors=${stats.errors.length}`);
  log(`wall=${((Date.now() - budget.startAt) / 1000).toFixed(1)}s`);
  log(`summary → ${join(OUT, 'summary.json')}`);
}

main().catch(async (err) => {
  console.error('[sweep] fatal:', err);
  try {
    writeFileSync(
      join(OUT, 'summary.json'),
      JSON.stringify({ label, stage: 'full', fatal: String(err?.message || err), stats: getStats() }, null, 2),
    );
  } catch {}
  await sleep(10);
  process.exit(1);
});
