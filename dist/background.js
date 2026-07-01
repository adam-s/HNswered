import { A as ALGOLIA_HITS_PER_PAGE, F as FETCH, a as ALGOLIA_API, D as DEFAULT_CONFIG, B as BACKFILL_DAY_OPTIONS, M as MAX_TICK_MINUTES, b as DAY_MS, c as AUTHOR_SYNC_MS, O as OVERLAP_MS, d as DROP_AGE_MS, R as RETENTION, e as ALARM, L as LOCK } from './assets/constants-DMzMIS1_.js';

function log(loc, msg, data) {
  return;
}
function logErr(loc, msg, err) {
  return;
}

const sleep$1 = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchJSON(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH.TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const body = await res.json();
    const elapsed = Date.now() - t0;
    log("algolia-client.fetchJSON", `OK attempt=${attempt} elapsedMs=${elapsed} url=${url}`);
    return body;
  } catch (err) {
    if (attempt >= FETCH.MAX_RETRIES) {
      throw err;
    }
    const backoff = Math.min(
      FETCH.BACKOFF_BASE_MS * 2 ** attempt,
      FETCH.BACKOFF_MAX_MS
    );
    await sleep$1(backoff);
    return fetchJSON(url, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}
const algoliaClient = {
  async searchComments(sinceEpochSec) {
    const url = `${ALGOLIA_API}/search_by_date?tags=comment&numericFilters=created_at_i%3E${sinceEpochSec}&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}`;
    const data = await fetchJSON(url);
    log("algolia-client.searchComments", `got ${data.hits.length} hits nbPages=${data.nbPages} sinceSec=${sinceEpochSec}`);
    return data.hits;
  },
  async searchByAuthor(user, sinceEpochSec) {
    const tag = `author_${encodeURIComponent(user)}`;
    const MAX_PAGES = 5;
    async function paginate(kind) {
      const out = [];
      let page = 0;
      while (page < MAX_PAGES) {
        const pageParam = page === 0 ? "" : `&page=${page}`;
        const url = `${ALGOLIA_API}/search_by_date?tags=${kind},${tag}&numericFilters=created_at_i%3E${sinceEpochSec}&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}${pageParam}`;
        const data = await fetchJSON(url);
        for (const h of data.hits) out.push(h);
        if (data.hits.length < ALGOLIA_HITS_PER_PAGE) break;
        page++;
        if (page < MAX_PAGES) await sleep$1(500);
      }
      return out;
    }
    const [stories, comments] = await Promise.all([paginate("story"), paginate("comment")]);
    const all = [...stories, ...comments];
    log("algolia-client.searchByAuthor", `user=${user} stories=${stories.length} comments=${comments.length} total=${all.length}`);
    return all;
  },
  async searchByParent(parentId, sinceEpochSec) {
    const out = [];
    const nf = sinceEpochSec !== void 0 ? `parent_id=${parentId},created_at_i%3E${sinceEpochSec}` : `parent_id=${parentId}`;
    const MAX_PAGES = 5;
    const PAGE_DELAY_MS = 500;
    let page = 0;
    while (page < MAX_PAGES) {
      const pageParam = page === 0 ? "" : `&page=${page}`;
      const url = `${ALGOLIA_API}/search_by_date?tags=comment&numericFilters=${nf}&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}${pageParam}`;
      const data = await fetchJSON(url);
      for (const h of data.hits) out.push(h);
      if (data.hits.length < ALGOLIA_HITS_PER_PAGE) break;
      page++;
      if (page < MAX_PAGES) await sleep$1(PAGE_DELAY_MS);
    }
    log("algolia-client.searchByParent", `parent=${parentId} sinceSec=${sinceEpochSec ?? "none"} hits=${out.length}`);
    return out;
  }
};

function createStore(area = chrome.storage.local) {
  async function get(key, fallback) {
    const res = await area.get(key);
    const value = res[key];
    return value ?? fallback;
  }
  async function set(key, value) {
    await area.set({ [key]: value });
  }
  return {
    async getConfig() {
      return get("config", { ...DEFAULT_CONFIG });
    },
    async setConfig(partial) {
      const current = await this.getConfig();
      const merged = { ...current, ...partial };
      const next = {
        ...merged,
        tickMinutes: Math.min(Math.max(1, merged.tickMinutes ?? DEFAULT_CONFIG.tickMinutes), MAX_TICK_MINUTES),
        backfillDays: BACKFILL_DAY_OPTIONS.includes(merged.backfillDays) ? merged.backfillDays : DEFAULT_CONFIG.backfillDays
      };
      await set("config", next);
      return next;
    },
    async getMonitored() {
      return get("monitored", {});
    },
    async setMonitored(monitored) {
      await set("monitored", monitored);
    },
    async upsertMonitored(item) {
      const current = await this.getMonitored();
      current[String(item.id)] = item;
      await set("monitored", current);
    },
    async removeMonitored(ids) {
      const current = await this.getMonitored();
      for (const id of ids) delete current[String(id)];
      await set("monitored", current);
    },
    async getReplies() {
      return get("replies", {});
    },
    async addReplies(newReplies) {
      const current = await this.getReplies();
      const before = Object.keys(current).length;
      for (const r of newReplies) {
        if (!current[String(r.id)]) current[String(r.id)] = r;
      }
      const after = Object.keys(current).length;
      const inserted = after - before;
      log("store.addReplies", `incoming=${newReplies.length} inserted=${inserted} before=${before} after=${after}`);
      if (inserted > 0) await set("replies", current);
      return inserted;
    },
    async markRead(id) {
      const current = await this.getReplies();
      const r = current[String(id)];
      if (r && !r.read) {
        r.read = true;
        await set("replies", current);
      }
    },
    async markAllRead() {
      const current = await this.getReplies();
      let changed = false;
      for (const r of Object.values(current)) {
        if (!r.read) {
          r.read = true;
          changed = true;
        }
      }
      if (changed) await set("replies", current);
    },
    async getUnreadCount() {
      const current = await this.getReplies();
      let n = 0;
      for (const r of Object.values(current)) if (!r.read) n++;
      return n;
    },
    async pruneReplies(opts) {
      const now = opts.now ?? Date.now();
      const current = await this.getReplies();
      const before = Object.keys(current).length;
      const monitored = opts.orphanedIfMonitoredMissing ? await this.getMonitored() : null;
      const entries = Object.entries(current);
      for (const [key, r] of entries) {
        if (opts.readOlderThanMs !== void 0 && r.read && now - r.discoveredAt > opts.readOlderThanMs) {
          delete current[key];
          continue;
        }
        if (monitored && r.read && !monitored[String(r.parentItemId)]) {
          delete current[key];
          continue;
        }
      }
      if (opts.hardCap !== void 0 && Object.keys(current).length > opts.hardCap) {
        const remaining = Object.values(current).sort((a, b) => {
          if (a.read !== b.read) return a.read ? -1 : 1;
          return a.discoveredAt - b.discoveredAt;
        });
        const over = remaining.length - opts.hardCap;
        for (let i = 0; i < over; i++) delete current[String(remaining[i].id)];
      }
      const after = Object.keys(current).length;
      if (after !== before) await set("replies", current);
      return before - after;
    },
    async clearRead() {
      const current = await this.getReplies();
      const before = Object.keys(current).length;
      for (const [key, r] of Object.entries(current)) {
        if (r.read) delete current[key];
      }
      const after = Object.keys(current).length;
      if (after !== before) await set("replies", current);
      return before - after;
    },
    async clearAllReplies() {
      const current = await this.getReplies();
      const n = Object.keys(current).length;
      if (n > 0) await set("replies", {});
      return n;
    },
    async clearPerUserState() {
      await area.remove([
        "replies",
        "monitored",
        "lastCommentPoll",
        "lastAuthorSync",
        "lastBackfillSweepAt",
        "backfillSweepFloor",
        "backfillQueue",
        "failureStreak"
      ]);
    },
    async getBytesInUse() {
      if (typeof area.getBytesInUse !== "function") return 0;
      return new Promise((resolve) => {
        try {
          const maybePromise = area.getBytesInUse(null, (b) => resolve(b ?? 0));
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then((b) => resolve(b ?? 0), () => resolve(0));
          }
        } catch {
          resolve(0);
        }
      });
    },
    async getTimestamps() {
      const res = await area.get(["lastCommentPoll", "lastAuthorSync", "lastBackfillSweepAt", "backfillSweepFloor"]);
      return {
        lastCommentPoll: res.lastCommentPoll ?? 0,
        lastAuthorSync: res.lastAuthorSync ?? 0,
        lastBackfillSweepAt: res.lastBackfillSweepAt ?? 0,
        backfillSweepFloor: res.backfillSweepFloor ?? 0
      };
    },
    async setTimestamp(key, ts) {
      await set(key, ts);
    },
    async getBackfillQueue() {
      return get("backfillQueue", []);
    },
    async setBackfillQueue(queue) {
      await set("backfillQueue", queue);
    },
    async getFailureStreak() {
      return get("failureStreak", { signature: "", count: 0 });
    },
    async setFailureStreak(streak) {
      await set("failureStreak", streak);
    },
    async clearFailureStreak() {
      const current = await this.getFailureStreak();
      if (current.count > 0) await area.remove("failureStreak");
    }
  };
}

function excerptFrom(html, maxChars = 140) {
  if (!html) return void 0;
  const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&#x2F;/g, "/").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  if (!text) return void 0;
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(" ");
  const trimTo = lastSpace > maxChars * 0.6 ? lastSpace : maxChars;
  return text.slice(0, trimTo).trimEnd() + "…";
}

const nowMs = () => Date.now();
function toMonitoredFromAuthorHit(hit) {
  const tags = hit._tags ?? [];
  const isStory = tags.includes("story") || hit.title != null;
  const isComment = tags.includes("comment") || hit.comment_text != null;
  if (!isStory && !isComment) return null;
  const type = isStory ? "story" : "comment";
  const id = Number(hit.objectID);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    type,
    submittedAt: hit.created_at_i * 1e3,
    title: isStory ? hit.title : void 0,
    excerpt: isComment && hit.comment_text ? excerptFrom(hit.comment_text, 140) : void 0
  };
}
function toReplyFromCommentHit(hit, parent) {
  if (!hit.author) return null;
  const id = Number(hit.objectID);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    parentItemId: parent.id,
    parentItemTitle: parent.type === "story" ? parent.title : void 0,
    parentAuthor: parent.type === "comment" ? parent.parentAuthor : void 0,
    parentExcerpt: parent.type === "comment" ? parent.excerpt : void 0,
    author: hit.author,
    text: hit.comment_text ?? "",
    time: hit.created_at_i * 1e3,
    read: false,
    discoveredAt: nowMs()
  };
}
function ageMs(item, now = nowMs()) {
  return now - item.submittedAt;
}
async function pollComments(client, store) {
  const config = await store.getConfig();
  if (!config.hnUser) {
    return { newReplies: 0, skipped: true, reason: "no-user" };
  }
  const hnUserLc = config.hnUser.toLowerCase();
  const monitored = await store.getMonitored();
  const parentIds = /* @__PURE__ */ new Set();
  for (const k of Object.keys(monitored)) {
    const n = Number(k);
    if (Number.isFinite(n)) parentIds.add(n);
  }
  if (parentIds.size === 0) {
    log("poller.pollComments", `skip reason=no-monitored user=${config.hnUser}`);
    await store.setTimestamp("lastCommentPoll", nowMs());
    return { newReplies: 0, skipped: true, reason: "no-monitored" };
  }
  const sinceSec = Math.floor((nowMs() - OVERLAP_MS) / 1e3);
  log("poller.pollComments", `ENTER user=${config.hnUser} monitoredCount=${parentIds.size} sinceSec=${sinceSec}`);
  const hits = await client.searchComments(sinceSec);
  log("poller.pollComments", `algolia returned ${hits.length} hits`);
  const replies = [];
  let selfSkip = 0;
  let notMonitoredSkip = 0;
  for (const h of hits) {
    if (!parentIds.has(h.parent_id)) {
      notMonitoredSkip++;
      continue;
    }
    if ((h.author ?? "").toLowerCase() === hnUserLc) {
      selfSkip++;
      continue;
    }
    const parent = monitored[String(h.parent_id)];
    if (!parent) continue;
    const r = toReplyFromCommentHit(h, parent);
    if (r) replies.push(r);
  }
  let inserted = 0;
  if (replies.length > 0) {
    inserted = await store.addReplies(replies);
    log("poller.pollComments", `candidates=${replies.length} inserted=${inserted} passed to addReplies`);
  }
  await store.setTimestamp("lastCommentPoll", nowMs());
  const hitRate = hits.length > 0 ? (replies.length / hits.length * 100).toFixed(1) : "0.0";
  const nextCommentPollFloorIso = new Date(nowMs() - OVERLAP_MS).toISOString();
  log(
    "poller.pollComments",
    `EXIT inserted=${inserted} candidates=${replies.length} hits=${hits.length} hitRate=${hitRate}% selfSkip=${selfSkip} notMonitoredSkip=${notMonitoredSkip} nextWindowStartIso=${nextCommentPollFloorIso}`
  );
  return { newReplies: inserted, skipped: false };
}
async function syncAuthor(client, store) {
  const config = await store.getConfig();
  if (!config.hnUser) {
    return 0;
  }
  const { lastAuthorSync } = await store.getTimestamps();
  const firstSync = !lastAuthorSync;
  const now = nowMs();
  const sinceMs = firstSync ? now - DROP_AGE_MS : Math.max(lastAuthorSync - OVERLAP_MS, now - DROP_AGE_MS);
  const sinceSec = Math.floor(sinceMs / 1e3);
  log("poller.syncAuthor", `ENTER user=${config.hnUser} firstSync=${firstSync} sinceSec=${sinceSec}`);
  const hits = await client.searchByAuthor(config.hnUser, sinceSec);
  log("poller.syncAuthor", `algolia returned ${hits.length} author hits`);
  const dropThreshold = now - DROP_AGE_MS;
  const monitored = await store.getMonitored();
  let added = 0;
  let skippedOld = 0;
  let skippedExisting = 0;
  for (const h of hits) {
    const m = toMonitoredFromAuthorHit(h);
    if (!m) continue;
    if (m.submittedAt < dropThreshold) {
      skippedOld++;
      continue;
    }
    const key = String(m.id);
    if (monitored[key]) {
      skippedExisting++;
      continue;
    }
    monitored[key] = m;
    added++;
  }
  if (added > 0) {
    await store.setMonitored(monitored);
  }
  const toDrop = [];
  for (const m of Object.values(monitored)) {
    if (ageMs(m, now) >= DROP_AGE_MS) toDrop.push(m.id);
  }
  if (toDrop.length > 0) {
    await store.removeMonitored(toDrop);
  }
  const retentionDays = Math.max(1, Number(config.retentionDays) || 30);
  await store.pruneReplies({
    readOlderThanMs: retentionDays * DAY_MS,
    hardCap: RETENTION.HARD_REPLY_CAP,
    orphanedIfMonitoredMissing: true,
    now
  });
  await store.setTimestamp("lastAuthorSync", now);
  log("poller.syncAuthor", `EXIT added=${added} skippedOld=${skippedOld} skippedExisting=${skippedExisting} dropped=${toDrop.length}`);
  return added;
}
async function maybeSyncAuthor(client, store) {
  const { lastAuthorSync } = await store.getTimestamps();
  const now = nowMs();
  const age = now - lastAuthorSync;
  if (lastAuthorSync > 0 && age < AUTHOR_SYNC_MS) {
    const nextEligibleAt = lastAuthorSync + AUTHOR_SYNC_MS;
    const msUntilEligible = nextEligibleAt - now;
    log(
      "poller.maybeSyncAuthor",
      `gated age=${age} cadence=${AUTHOR_SYNC_MS} msUntilEligible=${msUntilEligible} nextEligibleIso=${new Date(nextEligibleAt).toISOString()}`
    );
    return 0;
  }
  return syncAuthor(client, store);
}
function backfillDepthMs(config) {
  const days = Math.max(1, Number(config.backfillDays) || 7);
  return days * DAY_MS;
}
function computeBackfillSinceMs(opts) {
  const depthMs = Math.max(1, opts.backfillDays) * DAY_MS;
  return Math.min(opts.now, Math.max(opts.lastBackfillSweepAt, opts.now - depthMs));
}
async function maybeEnqueueBackfillSweep(store, now = nowMs()) {
  const config = await store.getConfig();
  if (!config.hnUser) return 0;
  const { lastCommentPoll, lastBackfillSweepAt, backfillSweepFloor } = await store.getTimestamps();
  const gap = now - lastCommentPoll;
  const neverSwept = lastBackfillSweepAt === 0;
  const absence = lastCommentPoll > 0 && gap > OVERLAP_MS;
  const firstPoll = lastCommentPoll === 0;
  if (!neverSwept && !absence && !firstPoll) {
    return 0;
  }
  const existingQueue = await store.getBackfillQueue();
  const invalidateDueToAbsence = absence && existingQueue.length > 0;
  if (existingQueue.length > 0 && !invalidateDueToAbsence) {
    log(
      "poller.maybeEnqueueBackfillSweep",
      `skip reason=sweep-in-progress queueLen=${existingQueue.length}`
    );
    return 0;
  }
  if (invalidateDueToAbsence) {
    log(
      "poller.BACKFILL.invalidate",
      `reason=absence-during-sweep gap=${gap} queueLen-was=${existingQueue.length} — re-enqueueing all in-window items with widened floor`
    );
  }
  const depthMs = backfillDepthMs(config);
  const cutoff = now - depthMs;
  const monitored = await store.getMonitored();
  const candidates = Object.values(monitored).filter((m) => m.submittedAt >= cutoff).sort((a, b) => b.submittedAt - a.submittedAt).map((m) => m.id);
  if (candidates.length === 0) return 0;
  const newFloor = computeBackfillSinceMs({ now, lastBackfillSweepAt, backfillDays: Number(config.backfillDays) || 7 });
  const pinnedFloor = backfillSweepFloor > 0 ? Math.min(backfillSweepFloor, newFloor) : newFloor;
  if (pinnedFloor !== backfillSweepFloor) {
    await store.setTimestamp("backfillSweepFloor", pinnedFloor);
  }
  const nextQueue = candidates;
  await store.setBackfillQueue(nextQueue);
  const trigger = firstPoll ? "first-poll" : neverSwept ? "never-swept" : "absence";
  log(
    "poller.BACKFILL.enqueue",
    `trigger=${trigger} enqueued=${candidates.length} queueTotal=${nextQueue.length} depth=${Number(config.backfillDays) || 7}d floorIso=${new Date(pinnedFloor).toISOString()} windowDaysBack=${((now - pinnedFloor) / DAY_MS).toFixed(2)}`
  );
  log(
    "poller.maybeEnqueueBackfillSweep",
    `gap=${gap} cutoff=${cutoff} pinnedFloor=${pinnedFloor} enqueued=${candidates.length} queueTotal=${nextQueue.length}`
  );
  return candidates.length;
}
async function drainOneBackfillItem(client, store, now = nowMs(), monitoredCache) {
  const queue = await store.getBackfillQueue();
  if (queue.length === 0) return 0;
  const config = await store.getConfig();
  if (!config.hnUser) return 0;
  const [head, ...rest] = queue;
  const monitored = monitoredCache ?? await store.getMonitored();
  const parent = monitored[String(head)];
  const { lastBackfillSweepAt, backfillSweepFloor } = await store.getTimestamps();
  if (!parent) {
    await store.setBackfillQueue(rest);
    if (rest.length === 0) {
      await store.setTimestamp("lastBackfillSweepAt", now);
      await store.setTimestamp("backfillSweepFloor", 0);
    }
    return 0;
  }
  const sweepFloorMs = backfillSweepFloor > 0 ? backfillSweepFloor : computeBackfillSinceMs({
    now,
    lastBackfillSweepAt,
    backfillDays: Number(config.backfillDays) || 7
  });
  const sinceMs = sweepFloorMs;
  const sinceSec = Math.floor(sinceMs / 1e3);
  const hits = await client.searchByParent(head, sinceSec);
  const hnUserLc = config.hnUser.toLowerCase();
  const replies = [];
  for (const h of hits) {
    if ((h.author ?? "").toLowerCase() === hnUserLc) continue;
    const r = toReplyFromCommentHit(h, parent);
    if (r) replies.push(r);
  }
  const inserted = replies.length > 0 ? await store.addReplies(replies) : 0;
  await store.setBackfillQueue(rest);
  const filtered = hits.length - replies.length;
  let verdict;
  if (inserted > 0) verdict = `SURFACED ${inserted} new`;
  else if (hits.length === 0) verdict = "no-hits";
  else if (filtered > 0 && replies.length === 0) verdict = `no-new (all ${filtered} filtered: self/invalid)`;
  else if (filtered > 0) verdict = `no-new (${replies.length} dupes + ${filtered} filtered)`;
  else verdict = `no-new (all ${replies.length} dupes)`;
  log(
    "poller.BACKFILL.drain",
    `parent=${head} sinceSec=${sinceSec} fetched=${hits.length} candidates=${replies.length} ${verdict} queueRemaining=${rest.length}`
  );
  if (rest.length === 0) {
    await store.setTimestamp("lastBackfillSweepAt", now);
    await store.setTimestamp("backfillSweepFloor", 0);
    log(
      "poller.BACKFILL.complete",
      `sweep drained — lastBackfillSweepAt=${new Date(now).toISOString()}, floor cleared. Next enqueue fires only on gap>${OVERLAP_MS / 6e4}min OR user/data change.`
    );
  }
  log(
    "poller.drainOneBackfillItem",
    `parent=${head} sinceSec=${sinceSec} hits=${hits.length} candidates=${replies.length} inserted=${inserted} queueRemaining=${rest.length}`
  );
  return inserted;
}
const DRAIN_ALL_DELAY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function drainBackfillQueueCompletely(client, store) {
  let itemsProcessed = 0;
  let repliesSurfaced = 0;
  const started = nowMs();
  const monitoredCache = await store.getMonitored();
  const initialLen = (await store.getBackfillQueue()).length;
  log(
    "poller.BACKFILL.drainAll.start",
    `queueLen=${initialLen} delayMs=${DRAIN_ALL_DELAY_MS} etaMinutes=${(initialLen * DRAIN_ALL_DELAY_MS / 6e4).toFixed(1)}`
  );
  while (true) {
    const queueBefore = await store.getBackfillQueue();
    if (queueBefore.length === 0) break;
    const inserted = await drainOneBackfillItem(client, store, nowMs(), monitoredCache);
    itemsProcessed++;
    repliesSurfaced += inserted;
    if (itemsProcessed > 5e3) {
      break;
    }
    const queueAfter = await store.getBackfillQueue();
    if (queueAfter.length > 0) {
      await sleep(DRAIN_ALL_DELAY_MS);
    }
  }
  const queueAtEnd = await store.getBackfillQueue();
  if (queueAtEnd.length === 0) {
    await store.setTimestamp("lastBackfillSweepAt", started);
    log(
      "poller.BACKFILL.drainAll.stamp",
      `lastBackfillSweepAt rewound to drain-start=${new Date(started).toISOString()} (not drain-end) so post-drain pollComments can recover missed replies`
    );
  }
  return { itemsProcessed, repliesSurfaced };
}

const FAILURE_STREAK_ERROR_THRESHOLD = 3;
function failureSignature(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\d+/g, "#");
}
async function recordFailure(store, err) {
  const signature = failureSignature(err);
  const prior = await store.getFailureStreak();
  const count = prior.signature === signature ? prior.count + 1 : 1;
  await store.setFailureStreak({ signature, count });
  return { count, escalate: count >= FAILURE_STREAK_ERROR_THRESHOLD };
}
async function recordSuccess(store) {
  await store.clearFailureStreak();
}

async function updateBadge(unreadCount) {
  const text = unreadCount > 0 ? unreadCount > 99 ? "99+" : String(unreadCount) : "";
  await chrome.action.setBadgeText({ text });
  if (unreadCount > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2d7d7d" });
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }
}

const store = createStore();
async function reportPollFailure(source, err) {
  const { count, escalate } = await recordFailure(store, err);
  if (escalate) {
    console.error(
      `[HNswered] ${source} failed — same error ${count} polls in a row. This is NOT a transient hiccup; likely an HN/Algolia API change or an extension bug. Reply capture may be degraded until it's addressed:`,
      err
    );
  } else {
    console.warn(`[HNswered] ${source} failed (${count}/${FAILURE_STREAK_ERROR_THRESHOLD} before escalation — transient unless it repeats):`, err);
  }
}
async function refreshBadge() {
  const n = await store.getUnreadCount();
  await updateBadge(n);
}
async function ensureAlarms() {
  const config = await store.getConfig();
  const requested = config.tickMinutes;
  const tickMin = Math.min(
    Math.max(1, config.tickMinutes || DEFAULT_CONFIG.tickMinutes),
    MAX_TICK_MINUTES
  );
  const existing = await chrome.alarms.get(ALARM.TICK);
  const existingPeriod = existing?.periodInMinutes ?? null;
  const existingNextMs = existing?.scheduledTime ?? null;
  if (!existing || existing.periodInMinutes !== tickMin) {
    await chrome.alarms.create(ALARM.TICK, {
      periodInMinutes: tickMin,
      delayInMinutes: tickMin
    });
    const created = await chrome.alarms.get(ALARM.TICK);
    log(
      "index.ensureAlarms",
      `ACTION=registered requested=${requested} clamped=${tickMin} existingPeriod=${existingPeriod} existingNextIso=${existingNextMs ? new Date(existingNextMs).toISOString() : "none"} newPeriod=${created?.periodInMinutes} newNextIso=${created ? new Date(created.scheduledTime).toISOString() : "none"}`
    );
  } else {
    log(
      "index.ensureAlarms",
      `ACTION=noop periodMin=${tickMin} (unchanged) nextIso=${existingNextMs ? new Date(existingNextMs).toISOString() : "none"}`
    );
  }
}
const MIN_REFRESH_INTERVAL_MS = 1e4;
let lastForceRefreshAt = 0;
async function withTickLock(fn) {
  return navigator.locks.request(LOCK.TICK, async () => fn());
}
async function runTick() {
  const lockRequestedAt = Date.now();
  await navigator.locks.request(LOCK.TICK, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      return;
    }
    const lockGrantedAt = Date.now();
    const lockWaitMs = lockGrantedAt - lockRequestedAt;
    try {
      const tickNow = lockGrantedAt;
      if (lockWaitMs > 50) {
        log("index.runTick", `lock-wait waitMs=${lockWaitMs}`);
      }
      const [cfg, ts, queue, alarm] = await Promise.all([
        store.getConfig(),
        store.getTimestamps(),
        store.getBackfillQueue(),
        chrome.alarms.get(ALARM.TICK)
      ]);
      const gap = ts.lastCommentPoll > 0 ? tickNow - ts.lastCommentPoll : Infinity;
      log("index.runTick", `STATE=enter nowIso=${new Date(tickNow).toISOString()} config=${JSON.stringify({ user: cfg.hnUser, tickMin: cfg.tickMinutes, backfillDays: cfg.backfillDays, retention: cfg.retentionDays })} gapMs=${gap === Infinity ? "first" : gap} ts=${JSON.stringify({ lastCommentPoll: ts.lastCommentPoll, lastAuthorSync: ts.lastAuthorSync, lastBackfillSweepAt: ts.lastBackfillSweepAt, backfillSweepFloor: ts.backfillSweepFloor })} queueLen=${queue.length} alarm=${alarm ? `period=${alarm.periodInMinutes} nextIso=${new Date(alarm.scheduledTime).toISOString()}` : "NONE"}`);
      await maybeSyncAuthor(algoliaClient, store);
      await maybeEnqueueBackfillSweep(store, tickNow);
      await pollComments(algoliaClient, store);
      await drainOneBackfillItem(algoliaClient, store, tickNow);
      await recordSuccess(store);
    } catch (err) {
      await reportPollFailure("tick", err);
    } finally {
      await refreshBadge();
    }
  });
}
async function runRefresh(fullDrain = false) {
  const now = Date.now();
  const sinceLastMs = now - lastForceRefreshAt;
  if (sinceLastMs < MIN_REFRESH_INTERVAL_MS) {
    await navigator.locks.request(LOCK.TICK, () => {
    });
    return;
  }
  lastForceRefreshAt = now;
  await navigator.locks.request(LOCK.TICK, async () => {
    try {
      const config = await store.getConfig();
      log("index.runRefresh", `config hnUser=${JSON.stringify(config.hnUser)} tickMin=${config.tickMinutes} retDays=${config.retentionDays}`);
      if (!config.hnUser) {
        log("index.runRefresh", `skip — no hnUser configured`);
        return;
      }
      const refreshNow = Date.now();
      const [rcfg, rts, rqueue] = await Promise.all([store.getConfig(), store.getTimestamps(), store.getBackfillQueue()]);
      log("index.runRefresh", `STATE=enter nowIso=${new Date(refreshNow).toISOString()} config=${JSON.stringify({ user: rcfg.hnUser, tickMin: rcfg.tickMinutes, backfillDays: rcfg.backfillDays, retention: rcfg.retentionDays })} ts=${JSON.stringify({ lastCommentPoll: rts.lastCommentPoll, lastAuthorSync: rts.lastAuthorSync, lastBackfillSweepAt: rts.lastBackfillSweepAt, backfillSweepFloor: rts.backfillSweepFloor })} queueLen=${rqueue.length}`);
      const added = await syncAuthor(algoliaClient, store);
      log("index.runRefresh", `syncAuthor added=${added}`);
      await maybeEnqueueBackfillSweep(store, refreshNow);
      const res = await pollComments(algoliaClient, store);
      log("index.runRefresh", `pollComments newReplies=${res.newReplies} skipped=${res.skipped} reason=${res.reason}`);
      if (fullDrain) {
        await drainBackfillQueueCompletely(algoliaClient, store);
      } else {
        await drainOneBackfillItem(algoliaClient, store, refreshNow);
      }
      await recordSuccess(store);
    } catch (err) {
      await reportPollFailure("refresh", err);
    } finally {
      await refreshBadge();
    }
  });
}
chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarms();
  await refreshBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  await refreshBadge();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  const driftMs = Date.now() - alarm.scheduledTime;
  log("index.onAlarm", `fired name=${alarm.name} scheduledIso=${new Date(alarm.scheduledTime).toISOString()} driftMs=${driftMs}`);
  if (alarm.name === ALARM.TICK) void runTick();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  log("index.onStorageChanged", `keys=${JSON.stringify(keys)}`);
  if (changes.replies) void refreshBadge();
});
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log("index.onMessage", `RECV kind=${message.kind} senderUrl=${sender?.url ?? "n/a"}`);
  const respond = (value) => sendResponse(value);
  (async () => {
    try {
      switch (message.kind) {
        case "list-replies": {
          const replies = await store.getReplies();
          respond({ ok: true, data: Object.values(replies).sort((a, b) => b.time - a.time) });
          return;
        }
        case "mark-read": {
          await withTickLock(() => store.markRead(message.id));
          respond({ ok: true });
          return;
        }
        case "mark-all-read": {
          await withTickLock(() => store.markAllRead());
          respond({ ok: true });
          return;
        }
        case "get-config": {
          const config = await store.getConfig();
          respond({ ok: true, data: config });
          return;
        }
        case "set-config": {
          log("index.onMessage.set-config", `INCOMING payload=${JSON.stringify(message.config)}`);
          const { config, userChanged, backfillWidened, nextUser } = await withTickLock(async () => {
            const prev = await store.getConfig();
            const next = await store.setConfig(message.config);
            const nextU = (next.hnUser ?? "").trim();
            const prevU = (prev.hnUser ?? "").trim();
            const changed = nextU !== prevU;
            const widened = !changed && (next.backfillDays ?? 7) > (prev.backfillDays ?? 7);
            if (changed) {
              log("index.onMessage", `user-changed from=${JSON.stringify(prevU)} to=${JSON.stringify(nextU)} → clearPerUserState`);
              await store.clearPerUserState();
            } else if (widened) {
              log("index.onMessage", `backfillDays widened ${prev.backfillDays}→${next.backfillDays} → clearing lastBackfillSweepAt + queue to trigger immediate re-sweep`);
              await store.setTimestamp("lastBackfillSweepAt", 0);
              await store.setTimestamp("backfillSweepFloor", 0);
              await store.setBackfillQueue([]);
            }
            log(
              "index.onMessage.set-config",
              `STORED prev=${JSON.stringify(prev)} next=${JSON.stringify(next)} userChanged=${changed} backfillWidened=${widened}`
            );
            return { config: next, userChanged: changed, backfillWidened: widened, nextUser: nextU };
          });
          if (userChanged) {
            await refreshBadge();
            if (nextUser) {
              log("index.onMessage", `user-changed → reset throttle + runRefresh(fullDrain=true) for user=${nextUser}`);
              lastForceRefreshAt = 0;
              void runRefresh(true);
            }
          } else if (backfillWidened) {
            log("index.onMessage", `backfillDays widened → running full catch-up inline`);
            void (async () => {
              await withTickLock(async () => {
                await maybeEnqueueBackfillSweep(store);
                await drainBackfillQueueCompletely(algoliaClient, store);
                await refreshBadge();
              });
            })();
          }
          await ensureAlarms();
          respond({ ok: true, data: config });
          return;
        }
        case "force-refresh": {
          await runRefresh();
          respond({ ok: true });
          return;
        }
        case "get-monitored": {
          const monitored = await store.getMonitored();
          respond({ ok: true, data: Object.values(monitored) });
          return;
        }
        case "reset-all": {
          await withTickLock(() => chrome.storage.local.clear());
          await refreshBadge();
          respond({ ok: true });
          return;
        }
        case "clear-read": {
          const n = await withTickLock(() => store.clearRead());
          await refreshBadge();
          respond({ ok: true, data: { dropped: n } });
          return;
        }
        case "clear-all-replies": {
          const n = await withTickLock(() => store.clearAllReplies());
          await refreshBadge();
          respond({ ok: true, data: { dropped: n } });
          return;
        }
        case "get-storage-stats": {
          const [replies, monitored, bytes] = await Promise.all([
            store.getReplies(),
            store.getMonitored(),
            store.getBytesInUse()
          ]);
          const all = Object.values(replies);
          respond({ ok: true, data: {
            replyCount: all.length,
            unreadCount: all.filter((r) => !r.read).length,
            monitoredCount: Object.keys(monitored).length,
            bytesInUse: bytes
          } });
          return;
        }
        case "inspect": {
          const all = await chrome.storage.local.get(null);
          log("index.inspect", `config=${JSON.stringify(all.config)}`);
          log("index.inspect", `timestamps lastCommentPoll=${all.lastCommentPoll} lastAuthorSync=${all.lastAuthorSync}`);
          const monitored = all.monitored ?? {};
          const mArr = Object.values(monitored);
          log("index.inspect", `monitored count=${mArr.length}`);
          for (const m of mArr) {
            const ageDays = ((Date.now() - m.submittedAt) / 864e5).toFixed(2);
            log("index.inspect.monitored", `id=${m.id} type=${m.type} ageDays=${ageDays} title=${JSON.stringify(m.title)}`);
          }
          const replies = all.replies ?? {};
          const rArr = Object.values(replies);
          const unread = rArr.filter((r) => !r.read).length;
          log("index.inspect", `replies count=${rArr.length} unread=${unread}`);
          const alarms = await chrome.alarms.getAll();
          for (const a of alarms) {
            log("index.inspect.alarm", `name=${a.name} scheduledTime=${a.scheduledTime} nextInMs=${a.scheduledTime - Date.now()} periodMin=${a.periodInMinutes}`);
          }
          respond({ ok: true, data: {
            config: all.config,
            monitored: mArr,
            replyCount: rArr.length,
            unreadCount: unread,
            timestamps: {
              lastCommentPoll: all.lastCommentPoll ?? null,
              lastAuthorSync: all.lastAuthorSync ?? null
            },
            alarms
          } });
          return;
        }
        default: {
          const kind = message.kind;
          log("index.onMessage", `UNKNOWN kind=${JSON.stringify(kind)}`);
          respond({ ok: false, error: `unknown message kind: ${String(kind)}` });
          return;
        }
      }
    } catch (err) {
      logErr("index.onMessage", `kind=${message.kind}`);
      respond({ ok: false, error: err.message });
    }
  })();
  return true;
});
void ensureAlarms();
void refreshBadge();
globalThis.__hnswered = {
  store,
  runTick,
  runRefresh,
  refreshBadge,
  ensureAlarms
};
//# sourceMappingURL=background.js.map
