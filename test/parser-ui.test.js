import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createApi } from '../public/api.js';
import * as parserUi from '../public/parser-ui.js';

const {
  completedQueueCount, eligibleGroup, isInteractiveRowTarget, normalizeDiscoveryViewPreference,
  parserEventLabel, parserStateLabel, reconcileSelectedGroups, safeOriginalUrl, safeTelegramPeerUrl,
} = parserUi;

test('Parser is pinned directly below Crypto and before Recent conversations', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['parser-open', 'parser-sidebar-status', 'parser-leads-today', 'parser-hot-leads', 'parser-workspace']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
  assert.ok(html.indexOf('id="crypto-open"') < html.indexOf('id="parser-open"'));
  assert.ok(html.indexOf('id="parser-open"') < html.indexOf('class="conversation-nav"'));
  assert.ok(html.indexOf('id="parser-workspace"') < html.indexOf('id="chat-scroll"'));
  assert.doesNotMatch(html, /iframe/i);
});

test('Parser browser API uses only local JARVIS routes and carries no provider URLs', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, text: async () => '{}' };
  } });
  await api.parserStatus();
  await api.parserReconnect();
  await api.parserDiscoveryStart(['saas founders']);
  await api.parserQueueAdd(['group-1']);
  await api.parserLeadFeedback('lead-1', 'GOOD');
  await api.parserAudit({ gate: 'NO_CONTEXT_GATE', potentialMissed: true });
  await api.saveParserSettings({ settings: { aiEnabled: true }, openrouterKey: 'secret' });
  assert.deepEqual(calls.map((call) => [call.options.method || 'GET', call.url]), [
    ['GET', '/api/parser/status'],
    ['POST', '/api/parser/telegram/reconnect'],
    ['POST', '/api/parser/discovery/start'],
    ['POST', '/api/parser/queue/add'],
    ['POST', '/api/parser/leads/lead-1/feedback'],
    ['GET', '/api/parser/audit?gate=NO_CONTEXT_GATE&potentialMissed=true'],
    ['PUT', '/api/parser/settings'],
  ]);
  assert.doesNotMatch(JSON.stringify(calls.map(({ url }) => url)), /openrouter|api\.telegram\.org|localhost:\d+/i);
});

test('Parser browser API exposes discovery-run filtering and safe completed cleanup locally', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, text: async () => '{}' };
  } });
  assert.equal(typeof api.parserDiscoveryRuns, 'function');
  assert.equal(typeof api.parserQueueClearCompleted, 'function');

  await api.parserDiscoveryRuns({ limit: 50, offset: 0 });
  await api.parserGroups({ runIds: ['run-a', 'run-b'], status: 'MONITORING', sort: 'score' });
  await api.parserQueueClearCompleted();

  assert.deepEqual(calls.map((call) => [call.options.method || 'GET', call.url]), [
    ['GET', '/api/parser/discovery/runs?limit=50&offset=0'],
    ['GET', '/api/parser/groups?runIds=run-a%2Crun-b&status=MONITORING&sort=score'],
    ['POST', '/api/parser/queue/clear-completed'],
  ]);
});

test('discovery view preference selects the actual latest run and preserves explicit hide-all', () => {
  assert.equal(typeof normalizeDiscoveryViewPreference, 'function');
  const runs = [
    { id: 'legacy', isLegacy: true, startedAt: '2026-08-25T12:00:00Z' },
    { id: 'latest', isLegacy: false, startedAt: '2026-08-25T11:00:00Z' },
    { id: 'old', isLegacy: false, startedAt: '2026-08-25T10:00:00Z' },
  ];

  assert.deepEqual(normalizeDiscoveryViewPreference(null, runs), {
    selectedRunIds: ['latest'], status: 'ALL', latestRunId: 'latest',
  });
  assert.deepEqual(normalizeDiscoveryViewPreference({ version: 1, selectedRunIds: [], status: 'NEW' }, runs), {
    selectedRunIds: [], status: 'NEW', latestRunId: 'latest',
  });
});

test('discovery view preference discards stale ids, validates status, and survives JSON input', () => {
  const runs = [{ id: 'latest', isLegacy: false }, { id: 'old', isLegacy: false }];
  assert.deepEqual(normalizeDiscoveryViewPreference(
    JSON.stringify({ version: 1, selectedRunIds: ['old', 'missing'], status: 'MONITORING' }), runs,
  ), { selectedRunIds: ['old'], status: 'MONITORING', latestRunId: 'latest' });
  assert.deepEqual(normalizeDiscoveryViewPreference(
    { version: 1, selectedRunIds: ['missing'], status: 'INVALID' }, runs,
  ), { selectedRunIds: ['latest'], status: 'ALL', latestRunId: 'latest' });
});

test('discovery view preference surfaces a run completed while the UI was closed', () => {
  const runs = [{ id: 'new' }, { id: 'old' }];
  assert.deepEqual(normalizeDiscoveryViewPreference({
    version: 1, selectedRunIds: ['old'], status: 'MONITORING', latestRunId: 'old',
  }, runs), {
    selectedRunIds: ['new'], status: 'ALL', latestRunId: 'new',
  });
  assert.deepEqual(normalizeDiscoveryViewPreference({
    version: 1, selectedRunIds: [], status: 'NEW', latestRunId: 'new',
  }, runs), {
    selectedRunIds: [], status: 'NEW', latestRunId: 'new',
  });
});

test('group selection helpers retain only visible canonical NEW rows', () => {
  assert.equal(typeof eligibleGroup, 'function');
  assert.equal(typeof reconcileSelectedGroups, 'function');
  const groups = [
    { id: 'new', lifecycle: 'NEW', status: 'DISCOVERED' },
    { id: 'queued', lifecycle: 'QUEUED', status: 'QUEUED' },
    { id: 'monitoring', lifecycle: 'MONITORING', status: 'MONITORING' },
  ];
  assert.equal(eligibleGroup(groups[0]), true);
  assert.equal(eligibleGroup(groups[1]), false);
  assert.deepEqual([...reconcileSelectedGroups(new Set(['new', 'queued', 'hidden']), groups)], ['new']);
});

test('row interaction helper excludes child controls and queue terminal count excludes active work', () => {
  assert.equal(typeof isInteractiveRowTarget, 'function');
  assert.equal(typeof completedQueueCount, 'function');
  assert.equal(isInteractiveRowTarget({ closest: () => ({ tagName: 'A' }) }), true);
  assert.equal(isInteractiveRowTarget({ closest: () => null }), false);
  assert.equal(completedQueueCount([
    { status: 'JOINED' }, { status: 'PRIVATE' }, { status: 'LIMIT_REACHED' },
    { status: 'QUEUED' }, { status: 'JOINING' }, { status: 'WAITING' },
    { status: 'RETRYABLE' }, { status: 'FLOOD_WAIT' },
  ]), 3);
});

test('delegated discovered-row events toggle rows and titles but never child controls', () => {
  assert.equal(typeof parserUi.groupForDiscoveredRowEvent, 'function');
  const group = { id: 'new', lifecycle: 'NEW' };
  const row = { dataset: { groupRow: 'new', selectable: 'true' } };
  const target = (interactive = false) => ({
    closest(selector) {
      if (selector === '[data-group-row]') return row;
      if (selector.includes('a, button, input')) return interactive ? this : null;
      return null;
    },
  });

  let selected = new Set();
  const rowGroup = parserUi.groupForDiscoveredRowEvent({ type: 'click', target: target() }, [group]);
  selected = parserUi.toggleGroupSelection(selected, rowGroup);
  assert.deepEqual([...selected], ['new']);
  const titleGroup = parserUi.groupForDiscoveredRowEvent({ type: 'click', target: target() }, [group]);
  selected = parserUi.toggleGroupSelection(selected, titleGroup);
  assert.deepEqual([...selected], []);

  for (const control of ['checkbox', 'Open Telegram', 'Remove', 'label']) {
    assert.equal(parserUi.groupForDiscoveredRowEvent({ type: 'click', target: target(true), control }, [group]), null);
  }

  let prevented = 0;
  assert.equal(parserUi.groupForDiscoveredRowEvent({
    type: 'keydown', key: 'Enter', target: target(), preventDefault: () => { prevented += 1; },
  }, [group]), group);
  assert.equal(parserUi.groupForDiscoveredRowEvent({
    type: 'keydown', key: ' ', target: target(), preventDefault: () => { prevented += 1; },
  }, [group]), group);
  assert.equal(prevented, 2);
  assert.equal(parserUi.groupForDiscoveredRowEvent({ type: 'keydown', key: 'Escape', target: target() }, [group]), null);
  assert.equal(parserUi.groupForDiscoveredRowEvent({
    type: 'click', target: { closest: (selector) => selector === '[data-group-row]' ? { dataset: { groupRow: 'new', selectable: 'false' } } : null },
  }, [group]), null);
});

test('discovery run panel renders independent visibility controls and compact actions', () => {
  assert.equal(typeof parserUi.renderDiscoveryRunsPanel, 'function');
  const html = parserUi.renderDiscoveryRunsPanel([
    { id: 'latest', title: 'Saas founders +1', state: 'COMPLETED', queryCount: 2, uniqueGroupCount: 18, startedAt: '2026-08-25T10:00:00Z' },
    { id: 'legacy', title: 'Legacy discoveries', state: 'COMPLETED', queryCount: 0, uniqueGroupCount: 247, isLegacy: true, startedAt: '2026-08-25T09:00:00Z' },
  ], new Set(['latest']));

  assert.match(html, /Discovery runs/);
  assert.match(html, /data-run-select="latest"[^>]*checked/);
  assert.match(html, /Saas founders \+1/);
  assert.match(html, /2 queries/);
  assert.match(html, /18 groups/);
  assert.match(html, /data-action="show-all-runs"/);
  assert.match(html, /data-action="hide-all-runs"/);
  assert.match(html, /data-action="latest-run-only"/);
});

test('discovered row markup is selectable only for NEW and exposes found-in/open controls safely', () => {
  assert.equal(typeof parserUi.renderDiscoveredGroupRow, 'function');
  const fresh = parserUi.renderDiscoveredGroupRow({
    id: 'new', title: 'Fresh founders', username: 'fresh_founders', telegramGroupId: '-107001',
    members: 1200, type: 'supergroup', language: 'en', topic: 'founders', score: 91,
    confidence: 'PRELIMINARY', lifecycle: 'NEW', foundInRuns: 2,
  }, true);
  const monitoring = parserUi.renderDiscoveredGroupRow({
    id: 'monitoring', title: 'Live group', telegramGroupId: '-107002', members: 800,
    type: 'supergroup', score: 80, lifecycle: 'MONITORING', foundInRuns: 1,
  }, false);

  assert.match(fresh, /data-group-row="new"/);
  assert.match(fresh, /tabindex="0"/);
  assert.match(fresh, /aria-selected="true"/);
  assert.match(fresh, /is-selected/);
  assert.match(fresh, /Found in 2 runs/);
  assert.match(fresh, /data-no-row-toggle/);
  assert.doesNotMatch(fresh, /data-group-select="new"[^>]*disabled/);
  assert.match(monitoring, /data-selectable="false"/);
  assert.match(monitoring, /data-group-select="monitoring"[^>]*disabled/);
  assert.doesNotMatch(monitoring, /tabindex="0"/);
});

test('discovery group request is absent for hide-all and includes server union/status otherwise', () => {
  assert.equal(typeof parserUi.discoveryGroupRequest, 'function');
  assert.equal(parserUi.discoveryGroupRequest(new Set(), 'ALL', { sort: 'score' }), null);
  assert.deepEqual(parserUi.discoveryGroupRequest(
    new Set(['run-a', 'run-b']), 'JOINED', { sort: 'score', minimumScore: 80 },
  ), { runIds: ['run-a', 'run-b'], status: 'JOINED', sort: 'score', minimumScore: 80 });
});

test('completed queue UI is disabled at zero and reports exact non-destructive copy', () => {
  assert.equal(typeof parserUi.renderQueueClearButton, 'function');
  assert.equal(typeof parserUi.queueClearMessage, 'function');
  assert.match(parserUi.renderQueueClearButton(0), /Clear completed/);
  assert.match(parserUi.renderQueueClearButton(0), /disabled/);
  assert.doesNotMatch(parserUi.renderQueueClearButton(2), /disabled/);
  assert.equal(parserUi.queueClearMessage(3), 'Cleared 3 completed queue items.');
  assert.equal(parserUi.queueClearMessage(0), 'No completed queue items to clear.');
  assert.match(parserUi.renderQueueRemoveAction({ id: 'active', status: 'QUEUED' }), /Remove/);
  assert.equal(parserUi.renderQueueRemoveAction({ id: 'done', status: 'JOINED' }), '—');
});

test('Clear completed refreshes only queue state from the authoritative response', async () => {
  assert.equal(typeof parserUi.clearCompletedQueueView, 'function');
  const calls = [];
  const remaining = { items: [{ id: 'active', status: 'FLOOD_WAIT' }], completedCount: 0 };
  const view = await parserUi.clearCompletedQueueView({
    async parserQueueClearCompleted() {
      calls.push('clear');
      return { cleared: 2, remaining };
    },
    async parserQueue() {
      calls.push('queue');
      throw new Error('fallback must not run when remaining is authoritative');
    },
  });

  assert.deepEqual(calls, ['clear']);
  assert.deepEqual(view, {
    queue: remaining,
    message: 'Cleared 2 completed queue items.',
    cleared: 2,
  });
});

test('Find Groups latest summary includes generated title and exact run counts', () => {
  assert.equal(typeof parserUi.discoveryRunSummary, 'function');
  assert.equal(parserUi.discoveryRunSummary({
    title: 'Saas founders +2', totalQueries: 3, groupsFound: 18,
  }), 'Saas founders +2 · 3 queries · 18 unique groups');
});

test('run visibility actions keep run selection separate from group selection', () => {
  assert.equal(typeof parserUi.runSelectionForAction, 'function');
  const runs = [{ id: 'legacy', isLegacy: true }, { id: 'latest', isLegacy: false }, { id: 'old' }];
  const groupSelection = new Set(['group-1']);
  assert.deepEqual([...parserUi.runSelectionForAction('show-all-runs', runs, new Set())], ['legacy', 'latest', 'old']);
  assert.deepEqual([...parserUi.runSelectionForAction('hide-all-runs', runs, new Set(['latest']))], []);
  assert.deepEqual([...parserUi.runSelectionForAction('latest-run-only', runs, new Set(['old']))], ['latest']);
  assert.deepEqual([...groupSelection], ['group-1']);
});

test('group toggle changes exactly one eligible id and leaves lifecycle/order untouched', () => {
  assert.equal(typeof parserUi.toggleGroupSelection, 'function');
  const groups = [
    { id: 'high', lifecycle: 'NEW', score: 95 },
    { id: 'joined', lifecycle: 'JOINED', score: 90 },
    { id: 'low', lifecycle: 'NEW', score: 80 },
  ];
  let selected = parserUi.toggleGroupSelection(new Set(), groups[0]);
  assert.deepEqual([...selected], ['high']);
  selected = parserUi.toggleGroupSelection(selected, groups[0]);
  assert.deepEqual([...selected], []);
  selected = parserUi.toggleGroupSelection(selected, groups[1]);
  assert.deepEqual([...selected], []);
  assert.deepEqual(groups.map((group) => group.id), ['high', 'joined', 'low']);
});

test('rerender keeps the discovered-list scroll position after selecting a group', () => {
  assert.equal(typeof parserUi.replaceParserWorkspace, 'function');
  let scroller = { scrollTop: 916, scrollLeft: 14 };
  const workspace = {
    querySelector(selector) {
      return selector === '.parser-workspace-scroll' ? scroller : null;
    },
    set innerHTML(value) {
      assert.match(value, /parser-workspace-scroll/);
      scroller = { scrollTop: 0, scrollLeft: 0 };
    },
  };

  parserUi.replaceParserWorkspace(workspace, '<div class="parser-workspace-scroll"></div>');

  assert.equal(scroller.scrollTop, 916);
  assert.equal(scroller.scrollLeft, 14);
});

test('background Parser refreshes retain list position while navigation starts at the top', () => {
  assert.equal(typeof parserUi.shouldPreserveParserWorkspaceScroll, 'function');
  assert.equal(parserUi.shouldPreserveParserWorkspaceScroll('queue', { spinner: false, sameTab: true }), true);
  assert.equal(parserUi.shouldPreserveParserWorkspaceScroll('monitoring', { spinner: false, sameTab: true }), true);
  assert.equal(parserUi.shouldPreserveParserWorkspaceScroll('leads', { spinner: false, sameTab: true }), true);
  assert.equal(parserUi.shouldPreserveParserWorkspaceScroll('audit', { spinner: false, sameTab: true }), true);
  assert.equal(parserUi.shouldPreserveParserWorkspaceScroll('discovered', { spinner: true, sameTab: true }), false);
  assert.equal(parserUi.shouldPreserveParserWorkspaceScroll('queue', { spinner: false, sameTab: false }), false);
});

test('Parser helpers expose exact states and reject unsafe message links', () => {
  assert.equal(parserStateLabel('SETUP_REQUIRED'), 'Setup required');
  assert.equal(parserStateLabel('RUNNING'), 'Running');
  assert.equal(parserStateLabel('DEGRADED'), 'Degraded');
  assert.equal(safeOriginalUrl('https://t.me/founders_chat/42'), 'https://t.me/founders_chat/42');
  assert.equal(safeOriginalUrl('javascript:alert(1)'), '');
  assert.equal(safeOriginalUrl('https://example.com/private'), '');
  assert.equal(safeTelegramPeerUrl('@founders_chat'), 'https://t.me/founders_chat');
  assert.equal(safeTelegramPeerUrl('bad/name'), '');
  assert.equal(parserEventLabel({ eventType: 'lead_detected', score: 94 }), 'Lead detected · score 94');
});

test('Monitoring distinguishes today from durable totals and renders catch-up status', async () => {
  const source = await readFile(new URL('../public/parser-ui.js', import.meta.url), 'utf8');
  for (const label of ['Messages today', 'Messages total', 'Candidates total', 'Leads total', 'History catch-up:', 'History synced through']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /renderMonitoring\(model\.monitoring, model\.status\)/);
});

test('Test AI success copy reports validated safe classifier metadata', () => {
  const message = parserUi.aiTestSuccessMessage?.({
    connected: true,
    model: 'google/gemma-4-26b-a4b-it:free',
    class: 'BUYER',
    schemaValidated: true,
    latencyMs: 143,
    ignored: 'openrouter-secret',
  });

  assert.equal(
    message,
    'AI classifier test passed. google/gemma-4-26b-a4b-it:free · BUYER · 143 ms',
  );
  assert.doesNotMatch(message, /openrouter-secret/);
});

test('Parser UI contains every required workspace and no auto-outreach implementation', async () => {
  const source = await readFile(new URL('../public/parser-ui.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const label of ['Overview', 'Find groups', 'Discovered', 'Join queue', 'Monitoring', 'Lead filters', 'Leads', 'Settings']) {
    assert.match(source, new RegExp(label, 'i'));
  }
  for (const label of ['Select recommended', 'Select score 90+', 'Open Telegram', 'Open profile', 'Last lead', 'Reconnect Telegram']) {
    assert.match(source, new RegExp(label, 'i'));
  }
  assert.match(source, /manual only/i);
  assert.match(source, /Nothing was sent/);
  assert.doesNotMatch(source, /auto(?:Reply|DM)|send_message_to_lead|massDM/i);
  assert.match(app, /import\('\.\/parser-ui\.js'\)/);
  assert.match(app, /parserController\?\.handleEvent/);
});

test('Parser styling stays restrained, keyboard-focusable, and reduced-motion safe', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.parser-nav-item/);
  assert.match(css, /\.parser-workspace/);
  assert.match(css, /\.parser-tabs/);
  assert.match(css, /\.parser-run-panel/);
  assert.match(css, /\.parser-group-row\.is-selected/);
  assert.match(css, /\.parser-group-row:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.parser-loading/);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\s*\(/i);
});
