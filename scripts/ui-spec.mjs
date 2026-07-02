#!/usr/bin/env node
/**
 * Asserted UI spec for the HNswered side panel — pass/fail, exit 1 on failure.
 *
 * Complements (does not replace) the report-only tools:
 *   - scripts/snapshot.mjs      visual capture for human review
 *   - scripts/perf-profile.mjs  CDP render profiling, printed
 * This file is the layer that ASSERTS: functional flows, structural render
 * budgets, reactivity, sanitization, overflow, and CDP leak trajectory.
 *
 * Fully offline: state is seeded straight into chrome.storage.local via the
 * SW harness hook. Makes ZERO HN requests — and asserts that at the end
 * (tickMinutes is seeded at 30 so no alarm can fire mid-run).
 *
 * Usage:
 *   pnpm ui                     # node scripts/ui-spec.mjs
 *   node scripts/ui-spec.mjs --headless=false   # watch it run
 */
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './lib/extension.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const HEADLESS = args.headless !== 'false';
const SHOTS = resolve(REPO, '.snapshots', 'ui-spec');
mkdirSync(SHOTS, { recursive: true });

const PAGE_SIZE = 50; // mirrors RETENTION.PAGE_SIZE — black-box constant, not an import
const PANEL = { width: 360, height: 900 }; // realistic side-panel width

// ---------------------------------------------------------------------------
// assertion collector — run everything, report everything, exit 1 if any fail
const results = [];
function check(section, name, cond, detail = '') {
  results.push({ section, name, pass: !!cond, detail: cond ? '' : String(detail) });
  const mark = cond ? '✓' : '✗';
  console.log(`  ${mark} ${name}${cond ? '' : `  — ${detail}`}`);
}

function seedReplies(n, { allRead = false, idBase = 10_000_000, text } = {}) {
  const now = Date.now();
  const out = {};
  for (let i = 0; i < n; i++) {
    const id = idBase + i;
    out[String(id)] = {
      id,
      parentItemId: 42_000_000 + (i % 10),
      parentItemTitle: `Post ${i % 10}`,
      author: `user${i % 20}`,
      text: text ?? `<p>Reply ${i} with a <a href="https://example.com">link</a>.</p>`,
      time: now - i * 60_000,
      read: allRead,
      discoveredAt: now - i * 30_000,
    };
  }
  return out;
}

async function seedState(ext, { user = 'ui_spec_user', replies = {} } = {}) {
  await ext.send({ kind: 'reset-all' });
  // tickMinutes 30: the alarm's first fire is >= 30 min out — it cannot fire
  // during this spec, so the run stays offline and deterministic.
  await ext.send({ kind: 'set-config', config: { hnUser: user, tickMinutes: 30, retentionDays: 30 } });
  await ext.sw.evaluate(async (r) => chrome.storage.local.set({ replies: r }), replies);
}

/** Open the panel with the render-gate armed BEFORE navigation: page errors,
 *  console errors, and an empty mount are collected and asserted by callers. */
async function openGated(ext, viewport = PANEL) {
  const page = await ext.context.newPage();
  await page.setViewportSize(viewport);
  const gate = { pageErrors: [], consoleErrors: [] };
  page.on('pageerror', (e) => gate.pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') gate.consoleErrors.push(m.text()); });
  await page.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
  await page.waitForSelector('.topbar', { timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  return { page, gate };
}

function assertGate(section, page, gate) {
  check(section, 'no page errors', gate.pageErrors.length === 0, gate.pageErrors.join(' | '));
  check(section, 'no console errors', gate.consoleErrors.length === 0, gate.consoleErrors.join(' | '));
  return page.evaluate(() => (document.getElementById('app')?.children.length ?? 0) > 0)
    .then((mounted) => check(section, 'app mounted (non-empty #app)', mounted));
}

async function main() {
  console.log('\nHNswered UI spec (offline, asserted)\n');
  const ext = await launchWithExtension({ headless: HEADLESS, logRequests: true });

  try {
    // -----------------------------------------------------------------
    console.log('1. empty state + render gate');
    {
      await ext.send({ kind: 'reset-all' });
      const { page, gate } = await openGated(ext);
      await assertGate('empty', page, gate);
      const emptyText = await page.locator('.empty').textContent();
      check('empty', 'unconfigured empty state prompts for setup',
        /no hn username configured/i.test(emptyText ?? ''), `got: ${emptyText}`);
      await page.screenshot({ path: resolve(SHOTS, 'empty.png') });
      await page.close();
    }

    // -----------------------------------------------------------------
    console.log('2. list rendering + counts');
    {
      await seedState(ext, { replies: seedReplies(7) });
      const { page, gate } = await openGated(ext);
      await page.waitForSelector('.reply');
      await assertGate('list', page, gate);
      check('list', 'renders one row per seeded reply',
        (await page.locator('.reply').count()) === 7);
      check('list', 'topbar shows watched user',
        /watching\s*ui_spec_user/.test((await page.locator('.topbar').innerText()).replace(/\n/g, ' ')));
      const subbar = (await page.locator('.subbar').innerText()).replace(/\s+/g, ' ');
      check('list', 'filter counts: all 7 / unread 7 / read 0',
        /all 7/.test(subbar) && /unread 7/.test(subbar) && /read 0/.test(subbar), subbar);
      await page.screenshot({ path: resolve(SHOTS, 'list-7.png') });

      // ---- mark one read via the row action
      await page.locator('.reply').first().getByRole('button', { name: 'mark read' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.reply:not(.read)').length === 6);
      const stats1 = await ext.send({ kind: 'get-storage-stats' });
      check('list', 'mark read persists to storage', stats1.data.unreadCount === 6,
        `storage unreadCount=${stats1.data?.unreadCount}`);

      // ---- mark all
      await page.getByRole('button', { name: 'mark all' }).click();
      await page.waitForSelector('.empty'); // unread filter drains to empty
      check('list', 'mark all: unread view drains to empty state',
        /no new replies/i.test((await page.locator('.empty').textContent()) ?? ''));
      const stats2 = await ext.send({ kind: 'get-storage-stats' });
      check('list', 'mark all persists to storage', stats2.data.unreadCount === 0,
        `storage unreadCount=${stats2.data?.unreadCount}`);

      // ---- reactivity: a new reply arrives while the panel is open
      await ext.sw.evaluate(async (r) => {
        const { replies } = await chrome.storage.local.get('replies');
        Object.assign(replies, r);
        await chrome.storage.local.set({ replies });
      }, seedReplies(1, { idBase: 99_000_000 }));
      await page.waitForSelector('.reply:not(.read)', { timeout: 5_000 });
      check('list', 'storage.onChanged pushes new reply into open panel without reload', true);
      await page.close();
    }

    // -----------------------------------------------------------------
    console.log('3. pagination + filters (structural render budget)');
    {
      await seedState(ext, { replies: seedReplies(300) });
      const { page, gate } = await openGated(ext);
      await page.waitForSelector('.reply');
      await assertGate('pagination', page, gate);
      check('pagination', `300 stored → exactly PAGE_SIZE (${PAGE_SIZE}) rendered`,
        (await page.locator('.reply').count()) === PAGE_SIZE,
        `rendered=${await page.locator('.reply').count()}`);
      check('pagination', '"More" link present', (await page.locator('.more').count()) === 1);
      await page.locator('.more a').click();
      await page.waitForFunction((n) => document.querySelectorAll('.reply').length === n, PAGE_SIZE * 2);
      check('pagination', 'More loads exactly one more page', true);
      await page.getByRole('button', { name: /^read/ }).click();
      check('pagination', 'read filter on all-unread set shows empty state',
        /nothing read yet/i.test((await page.locator('.empty').textContent().catch(() => '')) ?? ''));
      await page.close();
    }

    // -----------------------------------------------------------------
    console.log('4. sanitization (hostile reply text renders inert)');
    {
      const hostile =
        '<p>hi</p><script>window.__xssFired = true<' + '/script>' +
        '<img src=x onerror="window.__xssFired = true">' +
        '<a href="javascript:window.__xssFired = true">click</a>';
      await seedState(ext, { replies: seedReplies(1, { text: hostile }) });
      const { page, gate } = await openGated(ext);
      await page.waitForSelector('.reply');
      await page.waitForTimeout(300); // give any onerror a beat to fire
      check('sanitize', 'no script/onerror executed',
        !(await page.evaluate(() => window.__xssFired)));
      check('sanitize', 'no executable nodes survive in rendered text',
        (await page.locator('.reply .text script, .reply .text img, .reply .text [onerror]').count()) === 0);
      check('sanitize', 'no javascript: hrefs survive',
        (await page.locator('.reply .text a[href^="javascript:"]').count()) === 0);
      check('sanitize', 'hostile payload produced no page errors', gate.pageErrors.length === 0,
        gate.pageErrors.join(' | '));
      await page.close();
    }

    // -----------------------------------------------------------------
    console.log('5. layout lint at panel width (360px)');
    {
      await seedState(ext, { replies: seedReplies(30) });
      const { page, gate } = await openGated(ext);
      await page.waitForSelector('.reply');
      const layout = await page.evaluate(() => {
        const who = document.querySelector('.topbar .who')?.getBoundingClientRect();
        const verbs = document.querySelector('.topbar .verbs')?.getBoundingClientRect();
        return {
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          // Wrap detection is geometric, not a height constant: .topbar's
          // min-height is a design choice (32px, 46px at narrow via media
          // query), but .who and .verbs sharing a row is the invariant.
          sameRow: !!who && !!verbs && verbs.top < who.bottom,
        };
      });
      check('layout', 'no horizontal overflow at 360px', layout.scrollW <= layout.clientW,
        `scrollWidth=${layout.scrollW} clientWidth=${layout.clientW}`);
      check('layout', 'topbar does not wrap (.who and .verbs share a row)', layout.sameRow);
      check('layout', 'no console errors at narrow width', gate.consoleErrors.length === 0,
        gate.consoleErrors.join(' | '));
      await page.screenshot({ path: resolve(SHOTS, 'narrow-30.png'), fullPage: true });
      await page.close();
    }

    // -----------------------------------------------------------------
    console.log('6. storage-churn isolation (onStorageChanged key filter)');
    {
      await seedState(ext, { replies: seedReplies(10) });
      const { page } = await openGated(ext);
      await page.waitForSelector('.reply');
      await page.evaluate(() => {
        window.__mutations = 0;
        new MutationObserver((muts) => { window.__mutations += muts.length; })
          .observe(document.querySelector('.body'), { subtree: true, childList: true, characterData: true, attributes: true });
      });
      // Hammer the non-render keys the way a backfill drain would.
      await ext.sw.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          await chrome.storage.local.set({
            lastCommentPoll: Date.now() + i,
            backfillQueue: Array.from({ length: i }, (_, j) => j),
            backfillSweepFloor: i,
          });
        }
      });
      await page.waitForTimeout(500);
      const churnMutations = await page.evaluate(() => window.__mutations);
      check('churn', 'non-render key churn causes zero DOM mutations', churnMutations === 0,
        `${churnMutations} mutations`);
      // Sanity: the observer itself works — a replies write must mutate.
      await ext.sw.evaluate(async () => {
        const { replies } = await chrome.storage.local.get('replies');
        const first = Object.values(replies)[0];
        first.read = true;
        await chrome.storage.local.set({ replies });
      });
      await page.waitForFunction(() => window.__mutations > 0, undefined, { timeout: 5_000 });
      check('churn', 'replies write does mutate (observer sanity)', true);
      await page.close();
    }

    // -----------------------------------------------------------------
    console.log('7. CDP perf budgets (leak trajectory + node scaling)');
    {
      // (a) DOM-node scaling: 60 vs 300 stored both render PAGE_SIZE rows,
      // so total node count must be nearly identical.
      const nodesAt = async (stored) => {
        await seedState(ext, { replies: seedReplies(stored) });
        const { page } = await openGated(ext);
        await page.waitForSelector('.reply');
        const cdp = await ext.context.newCDPSession(page);
        await cdp.send('Performance.enable');
        const m = await cdp.send('Performance.getMetrics');
        const nodes = m.metrics.find((x) => x.name === 'Nodes')?.value ?? 0;
        await cdp.detach();
        await page.close();
        return nodes;
      };
      const n60 = await nodesAt(60);
      const n300 = await nodesAt(300);
      check('perf', `DOM nodes flat across stored sizes (60→${n60}, 300→${n300})`,
        n300 <= n60 * 1.25, 'pagination budget broken: nodes scale with stored count');

      // (b) Leak trajectory: repeated full re-renders must not accumulate
      // listeners or nodes. Toggle every reply's read flag 8 times; each
      // toggle triggers storage.onChanged → full list re-render.
      await seedState(ext, { replies: seedReplies(PAGE_SIZE) });
      const { page } = await openGated(ext);
      await page.waitForSelector('.reply');
      const cdp = await ext.context.newCDPSession(page);
      await cdp.send('Performance.enable');
      await cdp.send('HeapProfiler.enable');
      const sample = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        const m = await cdp.send('Performance.getMetrics');
        const get = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
        return { listeners: get('JSEventListeners'), nodes: get('Nodes'), docs: get('Documents') };
      };
      const samples = [];
      for (let cycle = 0; cycle < 8; cycle++) {
        await ext.sw.evaluate(async (flag) => {
          const { replies } = await chrome.storage.local.get('replies');
          for (const r of Object.values(replies)) r.read = flag;
          await chrome.storage.local.set({ replies });
        }, cycle % 2 === 1);
        await page.waitForTimeout(250);
        samples.push(await sample());
      }
      // Compare cycle 2 (post-warmup, same parity as cycle 8) to cycle 8.
      const warm = samples[1];
      const last = samples[7];
      check('perf', `listeners stable across re-render cycles (${warm.listeners}→${last.listeners})`,
        last.listeners <= warm.listeners + 10, 'listener leak trajectory');
      check('perf', `DOM nodes stable across re-render cycles (${warm.nodes}→${last.nodes})`,
        last.nodes <= warm.nodes * 1.1, 'node leak trajectory');
      check('perf', `no document accumulation (${warm.docs}→${last.docs})`,
        last.docs <= warm.docs, 'leaked documents/iframes');
      await cdp.detach();
      await page.close();
    }

    // -----------------------------------------------------------------
    console.log('8. politeness: the whole spec made zero HN requests');
    check('politeness', `0 HN requests during the run (saw ${ext.hnRequests.length})`,
      ext.hnRequests.length === 0, ext.hnRequests.slice(0, 3).map((r) => r.url).join(', '));
  } finally {
    await ext.close();
  }

  // ---------------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length} checks, ${failed.length} failed`);
  console.log(`screenshots: ${SHOTS}\n`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL [${f.section}] ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('ui-spec crashed:', err);
  process.exit(1);
});
