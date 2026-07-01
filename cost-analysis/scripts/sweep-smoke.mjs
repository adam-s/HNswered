// Stage 1 smoke test — validates API semantics, output schema, and backoff
// before committing to the full 20k-parent sweep. See plan file for gate
// criteria. Run: node cost-analysis/scripts/sweep-smoke.mjs --label=smoke-01

import { mkdirSync, writeFileSync } from 'node:fs';
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
  console.error('usage: sweep-smoke.mjs --label=<name> [--parents=100] [--concurrency=16] [--age-days=30]');
  process.exit(1);
}
const parents = Number.parseInt(args.parents ?? '100', 10);
const concurrency = Number.parseInt(args.concurrency ?? '16', 10);
const ageDays = Number.parseInt(args['age-days'] ?? '30', 10);

const OUT = join(process.cwd(), 'cost-analysis', 'data', label);
mkdirSync(OUT, { recursive: true });

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

const CROSSCHECK_N = 50;
const ALGOLIA = 'https://hn.algolia.com/api/v1';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

function log(msg) {
  const t = new Date().toISOString();
  console.log(`${t} [smoke] ${msg}`);
}

async function fetchParents(n, ageDaysLowerBound) {
  const cutoff = Math.floor(Date.now() / 1000) - ageDaysLowerBound * 86400;
  const url = `${ALGOLIA}/search_by_date?tags=story&numericFilters=created_at_i<${cutoff}&hitsPerPage=${Math.min(n, 1000)}`;
  log(`fetching parents: ${url}`);
  const res = await fetchWithBackoff(url);
  const data = await res.json();
  return data.hits.slice(0, n);
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

function bucketize(parentCreatedAt, children) {
  const counts = Object.fromEntries(Object.keys(WINDOWS_SEC).map((k) => [k, 0]));
  for (const c of children) {
    const age = c.created_at_i - parentCreatedAt;
    if (age < 0) continue;
    for (const [k, s] of Object.entries(WINDOWS_SEC)) {
      if (age <= s) counts[k]++;
    }
  }
  return counts;
}

function quantiles(vals) {
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: q(0.5),
    p90: q(0.9),
    p95: q(0.95),
    p99: q(0.99),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
  };
}

function aggregateWindows(rows) {
  const out = {};
  for (const w of Object.keys(WINDOWS_SEC)) {
    out[w] = quantiles(rows.map((r) => r.window_counts[w]));
  }
  return out;
}

async function main() {
  resetStats();
  const budget = makeBudget({ walltimeMs: 5 * 60 * 1000, requestCap: 10000 });

  log(`label=${label} parents=${parents} concurrency=${concurrency} ageDays=${ageDays}`);
  log(`out=${OUT}`);

  const parentHits = await fetchParents(parents, ageDays);
  log(`got ${parentHits.length} parents`);

  const sweepTasks = parentHits.map((p) => async () => {
    if (budget.exhausted()) throw new Error('budget exhausted');
    const kids = await fetchDirectChildren(p.objectID);
    const ids = kids.map((k) => k.objectID);
    return {
      parent_id: p.objectID,
      parent_type: 'story',
      author: p.author,
      created_at_i: p.created_at_i,
      points: p.points ?? null,
      num_comments_algolia_field: p.num_comments ?? null,
      direct_children_count: kids.length,
      direct_children_ids: ids,
      window_counts: bucketize(p.created_at_i, kids),
    };
  });

  log(`sweep: fetching children for ${sweepTasks.length} parents at concurrency=${concurrency}...`);
  const sweepResults = await runConcurrent(sweepTasks, concurrency);
  const sweepRows = sweepResults.filter((r) => r.ok).map((r) => r.value);
  const sweepErrorsList = sweepResults
    .map((r, i) => (!r.ok ? { parent_id: parentHits[i].objectID, error: String(r.error?.message || r.error) } : null))
    .filter(Boolean);
  log(`sweep done: ok=${sweepRows.length} errors=${sweepErrorsList.length}`);

  const shuffled = [...sweepRows].sort(() => Math.random() - 0.5);
  const crossSample = shuffled.slice(0, CROSSCHECK_N);
  log(`crosscheck: ${crossSample.length} parents vs Firebase kids[] (live-filtered)`);
  const crossTasks = crossSample.map((row) => async () => {
    const fbKidsRaw = await fetchFirebaseKidsRaw(row.parent_id);
    const algSet = new Set(row.direct_children_ids.map(String));
    const fbSetRaw = new Set(fbKidsRaw);
    const fbOnlyRaw = [...fbSetRaw].filter((x) => !algSet.has(x));
    // Only pay per-kid classification cost for ids Algolia is missing —
    // dead/deleted accounts for most of the gap.
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
    const fbLiveCount = fbSetRaw.size - fbOnlyDead; // lower bound; intersect kids assumed live (Algolia filters them in)
    const intersect = [...algSet].filter((x) => fbSetRaw.has(x)).length;
    const algOnly = [...algSet].filter((x) => !fbSetRaw.has(x)).length;
    return {
      parent_id: row.parent_id,
      algolia_count: algSet.size,
      firebase_raw_count: fbSetRaw.size,
      firebase_live_count: fbLiveCount,
      intersect,
      algolia_only: algOnly,
      firebase_only_raw: fbOnlyRaw.length,
      firebase_only_dead_or_deleted: fbOnlyDead,
      firebase_only_live: fbOnlyLive,
    };
  });
  const crossResults = await runConcurrent(crossTasks, concurrency);
  const crossRows = crossResults.filter((r) => r.ok).map((r) => r.value);
  const crossErrorsList = crossResults
    .map((r, i) => (!r.ok ? { parent_id: crossSample[i].parent_id, error: String(r.error?.message || r.error) } : null))
    .filter(Boolean);
  log(`crosscheck done: ok=${crossRows.length} errors=${crossErrorsList.length}`);

  const rawAgreementRate =
    crossRows.length === 0
      ? null
      : crossRows.reduce((s, r) => s + (r.firebase_raw_count > 0 ? r.intersect / r.firebase_raw_count : 1), 0) / crossRows.length;
  const liveAgreementRate =
    crossRows.length === 0
      ? null
      : crossRows.reduce((s, r) => s + (r.firebase_live_count > 0 ? r.intersect / r.firebase_live_count : 1), 0) / crossRows.length;
  const perfectMatches = crossRows.filter((r) => r.algolia_only === 0 && r.firebase_only_live === 0).length;

  writeFileSync(join(OUT, 'sweep.jsonl'), sweepRows.map((r) => JSON.stringify(r)).join('\n') + (sweepRows.length ? '\n' : ''));
  writeFileSync(join(OUT, 'crosscheck.jsonl'), crossRows.map((r) => JSON.stringify(r)).join('\n') + (crossRows.length ? '\n' : ''));

  const stats = getStats();
  const summary = {
    label,
    stage: 'smoke',
    started_at: new Date(budget.startAt).toISOString(),
    finished_at: new Date().toISOString(),
    wall_ms: Date.now() - budget.startAt,
    inputs: { parents, concurrency, ageDays },
    parents_fetched: parentHits.length,
    sweep_ok: sweepRows.length,
    sweep_errors: sweepErrorsList,
    crosscheck_count: crossRows.length,
    crosscheck_errors: crossErrorsList,
    raw_agreement_rate: rawAgreementRate,
    live_agreement_rate: liveAgreementRate,
    perfect_match_rate: crossRows.length ? perfectMatches / crossRows.length : null,
    agreement_note:
      'raw = Algolia vs unfiltered Firebase kids[]; live = Algolia vs Firebase kids[] minus dead/deleted. Algolia excludes dead/deleted by design, so live is the correctness metric for the extension.',
    total_requests: stats.requests,
    throttles: stats.throttles,
    throttle_count: stats.throttles.length,
    errors_from_http: stats.errors,
    window_aggregates: aggregateWindows(sweepRows),
  };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

  log(`---`);
  log(`sweep_ok=${sweepRows.length}/${parentHits.length} errors=${sweepErrorsList.length}`);
  log(`raw_agreement=${rawAgreementRate?.toFixed(4)} live_agreement=${liveAgreementRate?.toFixed(4)} perfect=${summary.perfect_match_rate?.toFixed(4)}`);
  log(`total_requests=${stats.requests} throttles=${stats.throttles.length}`);
  log(`summary → ${join(OUT, 'summary.json')}`);
}

main().catch(async (err) => {
  console.error('[smoke] fatal:', err);
  const stats = getStats();
  try {
    writeFileSync(
      join(OUT, 'summary.json'),
      JSON.stringify({ label, stage: 'smoke', fatal: String(err?.message || err), stats }, null, 2),
    );
  } catch {}
  await sleep(10);
  process.exit(1);
});
