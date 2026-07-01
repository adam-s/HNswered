// Research-tooling HTTP helper. Not for production use — production polling
// lives in src/ and obeys src/shared/constants.ts caps. This helper is for
// one-shot research probes per the AGENTS.md research-tooling carveout:
// prefer concurrency + reactive 403/429 backoff over preemptive delays; log
// throttled responses visibly.

let stats = { requests: 0, throttles: [], errors: [] };

export function resetStats() {
  stats = { requests: 0, throttles: [], errors: [] };
}

export function getStats() {
  return stats;
}

const RETRY_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

export async function fetchWithBackoff(url, opts = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    stats.requests++;
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      const transient = err?.cause?.code === 'ECONNRESET' || err?.cause?.code === 'ETIMEDOUT' || /fetch failed/i.test(String(err));
      if (transient && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * 1000;
        console.error(`[http] network ${err?.cause?.code || err.message} on ${url} attempt=${attempt} delaying ${delay | 0}ms`);
        await sleep(delay);
        continue;
      }
      stats.errors.push({ url, error: String(err?.message || err), attempt, ts: Date.now() });
      throw err;
    }
    if (res.ok) return res;
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * 1000;
      stats.throttles.push({ url, status: res.status, attempt, ts: Date.now() });
      console.error(`[http] ${res.status} on ${url} attempt=${attempt} delaying ${delay | 0}ms`);
      await sleep(delay);
      continue;
    }
    stats.errors.push({ url, status: res.status, attempt, ts: Date.now() });
    throw new Error(`HTTP ${res.status} after ${attempt} retries: ${url}`);
  }
  throw new Error(`fetchWithBackoff exhausted retries: ${url}`);
}

export async function runConcurrent(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function makeBudget({ walltimeMs, requestCap }) {
  const startAt = Date.now();
  const endAt = startAt + walltimeMs;
  return {
    startAt,
    endAt,
    requestCap,
    remaining() {
      return { wallMs: endAt - Date.now(), requests: requestCap - stats.requests };
    },
    exhausted() {
      return Date.now() >= endAt || stats.requests >= requestCap;
    },
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
