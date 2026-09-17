const TABS = Object.freeze([
  ['overview', 'Overview'],
  ['find', 'Find groups'],
  ['discovered', 'Discovered'],
  ['queue', 'Join queue'],
  ['monitoring', 'Monitoring'],
  ['filters', 'Lead filters'],
  ['leads', 'Leads'],
  ['audit', 'Audit'],
  ['settings', 'Settings'],
]);

const ACTIVE_STATES = new Set(['STARTING', 'RUNNING', 'PAUSED', 'STOPPING']);
const DISCOVERY_STATUSES = new Set(['ALL', 'NEW', 'QUEUED', 'JOINED', 'MONITORING']);
const TERMINAL_QUEUE_STATES = new Set(['JOINED', 'PRIVATE', 'UNAVAILABLE', 'BANNED', 'DELETED', 'LIMIT_REACHED']);
const ACTIVE_QUEUE_STATES = new Set(['QUEUED', 'JOINING', 'WAITING', 'RETRYABLE', 'FLOOD_WAIT']);
const DISCOVERY_VIEW_KEY = 'jarvis.parser.discovery-view.v1';

function preferredLatestRun(runs = []) {
  return runs.find((run) => !run?.isLegacy) || runs[0] || null;
}

export function normalizeDiscoveryViewPreference(value, runs = []) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = null; }
  }
  const validIds = new Set((Array.isArray(runs) ? runs : []).map((run) => String(run.id)));
  const latest = preferredLatestRun(Array.isArray(runs) ? runs : []);
  const latestRunId = latest?.id ? String(latest.id) : null;
  const savedLatestRunId = parsed?.latestRunId ? String(parsed.latestRunId) : null;
  const hasSavedSelection = parsed?.version === 1 && Array.isArray(parsed.selectedRunIds);
  const requested = hasSavedSelection ? [...new Set(parsed.selectedRunIds.map(String))] : [];
  const selectedRunIds = requested.filter((id) => validIds.has(id));
  let status = DISCOVERY_STATUSES.has(String(parsed?.status || '').toUpperCase())
    ? String(parsed.status).toUpperCase()
    : 'ALL';
  if (savedLatestRunId && latestRunId && savedLatestRunId !== latestRunId) {
    selectedRunIds.splice(0, selectedRunIds.length, latestRunId);
    status = 'ALL';
  } else if (!hasSavedSelection || (requested.length > 0 && selectedRunIds.length === 0)) {
    if (latestRunId) selectedRunIds.push(latestRunId);
  }
  return { selectedRunIds, status, latestRunId };
}

export function eligibleGroup(group) {
  return (group?.lifecycle || (group?.status === 'DISCOVERED' ? 'NEW' : group?.status)) === 'NEW';
}

export function reconcileSelectedGroups(selected, visibleGroups = []) {
  const eligibleVisibleIds = new Set(visibleGroups.filter(eligibleGroup).map((group) => String(group.id)));
  return new Set([...selected].filter((id) => eligibleVisibleIds.has(String(id))));
}

export function toggleGroupSelection(selected, group) {
  const next = new Set(selected);
  if (!eligibleGroup(group)) return next;
  if (next.has(group.id)) next.delete(group.id);
  else next.add(group.id);
  return next;
}

export function runSelectionForAction(action, runs = [], current = new Set()) {
  if (action === 'show-all-runs') return new Set(runs.map((run) => run.id));
  if (action === 'hide-all-runs') return new Set();
  if (action === 'latest-run-only') {
    const latest = preferredLatestRun(runs);
    return new Set(latest?.id ? [latest.id] : []);
  }
  return new Set(current);
}

export function isInteractiveRowTarget(target) {
  return Boolean(target?.closest?.('a, button, input, select, textarea, label, [data-no-row-toggle]'));
}

export function groupForDiscoveredRowEvent(event, groups = []) {
  const row = event?.target?.closest?.('[data-group-row]');
  if (!row || row.dataset?.selectable !== 'true' || isInteractiveRowTarget(event.target)) return null;
  if (event.type === 'keydown') {
    if (!['Enter', ' '].includes(event.key)) return null;
    event.preventDefault?.();
  } else if (event.type !== 'click') {
    return null;
  }
  return groups.find((group) => String(group.id) === String(row.dataset.groupRow)) || null;
}

export function completedQueueCount(items = []) {
  return items.filter((item) => TERMINAL_QUEUE_STATES.has(item?.status)).length;
}

export function queueClearMessage(cleared) {
  return integer(cleared) > 0
    ? `Cleared ${integer(cleared)} completed queue items.`
    : 'No completed queue items to clear.';
}

export function renderQueueClearButton(count) {
  return `<button class="parser-secondary" type="button" data-action="clear-completed-queue"${integer(count) > 0 ? '' : ' disabled'}>Clear completed</button>`;
}

export function renderQueueRemoveAction(item) {
  if (!ACTIVE_QUEUE_STATES.has(item?.status)) return '—';
  return `<button class="parser-text-button" type="button" data-action="remove-queue" data-id="${escapeHtml(item.id)}">Remove</button>`;
}

export function replaceParserWorkspace(workspace, html) {
  const previousScroller = workspace?.querySelector?.('.parser-workspace-scroll');
  const scrollTop = Number.isFinite(previousScroller?.scrollTop) ? previousScroller.scrollTop : 0;
  const scrollLeft = Number.isFinite(previousScroller?.scrollLeft) ? previousScroller.scrollLeft : 0;
  workspace.innerHTML = html;
  const nextScroller = workspace.querySelector?.('.parser-workspace-scroll');
  if (!nextScroller) return;
  nextScroller.scrollTop = scrollTop;
  nextScroller.scrollLeft = scrollLeft;
}

export function shouldPreserveParserWorkspaceScroll(_tab, { spinner = false, sameTab = true } = {}) {
  return !spinner && sameTab;
}

export async function clearCompletedQueueView(api) {
  const result = await api.parserQueueClearCompleted();
  const queue = result.remaining || await api.parserQueue();
  return { queue, message: queueClearMessage(result.cleared), cleared: integer(result.cleared) };
}

export function discoveryRunSummary(run) {
  return `${run?.title || 'Discovery run'} · ${integer(run?.totalQueries)} queries · ${integer(run?.groupsFound)} unique groups`;
}

export function parserStateLabel(state) {
  return ({
    SETUP_REQUIRED: 'Setup required', STOPPED: 'Stopped', STARTING: 'Starting', RUNNING: 'Running',
    PAUSED: 'Paused', DEGRADED: 'Degraded', ERROR: 'Error', STOPPING: 'Stopping',
  })[state] || 'Unavailable';
}

export function safeOriginalUrl(value) {
  const url = String(value || '').trim();
  return /^https:\/\/t\.me\/[A-Za-z0-9_]{4,32}\/\d+$/.test(url) ? url : '';
}

export function safeTelegramPeerUrl(value) {
  const username = String(value || '').trim().replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username) ? `https://t.me/${username}` : '';
}

export function parserEventLabel(event) {
  const type = event?.eventType || event?.type;
  const labels = {
    parser_state: `Parser ${String(event?.state || '').toLowerCase()}`,
    telegram_connected: 'Telegram account connected', telegram_disconnected: 'Telegram account disconnected',
    discovery_progress: event?.query ? `Searching “${event.query}”` : 'Discovery progress updated',
    discovery_completed: `Discovery completed · ${event?.groupsFound || 0} groups`,
    join_progress: `${event?.group || 'Group'} · ${String(event?.state || '').replaceAll('_', ' ').toLowerCase()}`,
    candidate_detected: 'Buyer candidate detected', lead_detected: `Lead detected · score ${event?.score || 0}`,
    notification_sent: 'Lead notification delivered', notification_test: 'Test notification delivered',
    settings_saved: 'Parser settings saved', telegram_login: 'Telegram login code requested',
  };
  return labels[type] || String(type || 'Parser activity').replaceAll('_', ' ');
}

export function aiTestSuccessMessage(result) {
  const model = String(result?.model || 'model ready').slice(0, 160);
  const classification = String(result?.class || 'validated').slice(0, 32);
  const latency = Math.max(0, Math.round(Number(result?.latencyMs) || 0));
  return `AI classifier test passed. ${model} · ${classification} · ${latency} ms`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function timeLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function elapsedLabel(startValue, endValue) {
  const start = new Date(startValue).getTime();
  const end = endValue ? new Date(endValue).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateTone(state) {
  if (state === 'RUNNING' || state === 'CONNECTED' || state === 'SENT' || state === 'JOINED' || state === 'MONITORING') return 'good';
  if (state === 'ERROR' || state === 'DEGRADED' || state === 'FAILED' || state === 'BANNED') return 'bad';
  if (state === 'FLOOD_WAIT' || state === 'PAUSED' || state === 'WAITING_FOR_CODE' || state === 'WAITING_FOR_2FA') return 'warn';
  return 'quiet';
}

function badge(value, tone = stateTone(value)) {
  return `<span class="parser-badge" data-tone="${escapeHtml(tone)}">${escapeHtml(String(value || '—').replaceAll('_', ' '))}</span>`;
}

export function discoveryGroupRequest(selectedRunIds, status = 'ALL', filters = {}) {
  const runIds = [...selectedRunIds];
  if (runIds.length === 0) return null;
  return { runIds, status, ...filters };
}

export function renderDiscoveryRunsPanel(runs = [], selectedRunIds = new Set()) {
  const rows = runs.map((run) => {
    const queryLabel = `${integer(run.queryCount)} ${integer(run.queryCount) === 1 ? 'query' : 'queries'}`;
    const groupLabel = `${integer(run.uniqueGroupCount)} ${integer(run.uniqueGroupCount) === 1 ? 'group' : 'groups'}`;
    return `<label class="parser-run-option"><input type="checkbox" data-run-select="${escapeHtml(run.id)}"${selectedRunIds.has(run.id) ? ' checked' : ''} /><span><strong>${escapeHtml(run.title || 'Discovery run')}</strong><small>${escapeHtml(timeLabel(run.startedAt))} · ${queryLabel} · ${groupLabel}</small></span>${badge(run.state || 'UNKNOWN', 'quiet')}</label>`;
  }).join('');
  return `<section class="parser-run-panel" aria-labelledby="parser-runs-title"><header><div><span class="parser-kicker">DISCOVERY HISTORY</span><h2 id="parser-runs-title">Discovery runs</h2></div><div class="parser-run-actions"><button class="parser-text-button" type="button" data-action="show-all-runs">Show all</button><button class="parser-text-button" type="button" data-action="hide-all-runs">Hide all</button><button class="parser-text-button" type="button" data-action="latest-run-only">Latest only</button></div></header><div class="parser-run-list" role="group" aria-label="Visible discovery runs">${rows || '<p class="parser-run-empty">No discovery runs yet.</p>'}</div></section>`;
}

export function renderDiscoveredGroupRow(group, selected = false) {
  const selectable = eligibleGroup(group);
  const telegram = safeTelegramPeerUrl(group.username);
  const activity = group.activityScore === null || group.activityScore === undefined ? '—' : integer(group.activityScore);
  const lifecycle = group.lifecycle || (group.status === 'DISCOVERED' ? 'NEW' : group.status) || 'NEW';
  const found = integer(group.foundInRuns) > 1 ? `<small>Found in ${integer(group.foundInRuns)} runs</small>` : '';
  return `<tr class="parser-group-row${selected ? ' is-selected' : ''}" data-group-row="${escapeHtml(group.id)}" data-selectable="${selectable}"${selectable ? ' tabindex="0"' : ''} aria-selected="${selected}"><td><input type="checkbox" data-group-select="${escapeHtml(group.id)}"${selected ? ' checked' : ''}${selectable ? '' : ' disabled'} aria-label="Select ${escapeHtml(group.title)}" /></td><td><div class="parser-table-title"><strong>${escapeHtml(group.title)}</strong><small>${group.username ? `@${escapeHtml(group.username)}` : escapeHtml(group.telegramGroupId)}</small>${found}</div></td><td>${integer(group.members).toLocaleString()}</td><td>${badge(group.type, 'quiet')}</td><td>${escapeHtml(group.language || '—')}</td><td>${escapeHtml(group.topic || '—')}</td><td>${escapeHtml(activity)}</td><td><span class="parser-score" data-score="${integer(group.score)}">${integer(group.score)}</span><small>${escapeHtml(group.confidence || '')}</small></td><td>${badge(lifecycle)}</td><td><div class="parser-row-actions">${telegram ? `<a class="parser-text-button" data-no-row-toggle href="${escapeHtml(telegram)}" target="_blank" rel="noreferrer">Open Telegram</a>` : ''}<button class="parser-icon-action" data-no-row-toggle type="button" data-action="ignore-group" data-id="${escapeHtml(group.id)}" title="Ignore group">×</button></div></td></tr>`;
}

function emptyState(title, copy, action = '') {
  return `<div class="parser-empty"><span class="parser-empty-mark" aria-hidden="true">P</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(copy)}</p>${action}</div>`;
}

function settingField(name, label, value, options = {}) {
  const type = options.type || 'text';
  const hint = options.hint ? `<small>${escapeHtml(options.hint)}</small>` : '';
  const placeholder = options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : '';
  const min = options.min === undefined ? '' : ` min="${options.min}"`;
  const max = options.max === undefined ? '' : ` max="${options.max}"`;
  return `<label class="parser-field"><span>${escapeHtml(label)}</span><input name="${escapeHtml(name)}" type="${type}" value="${escapeHtml(value ?? '')}"${placeholder}${min}${max} autocomplete="${options.autocomplete || 'off'}" />${hint}</label>`;
}

function checkbox(name, label, checked, copy = '') {
  return `<label class="parser-check"><input name="${escapeHtml(name)}" type="checkbox"${checked ? ' checked' : ''} /><span><strong>${escapeHtml(label)}</strong>${copy ? `<small>${escapeHtml(copy)}</small>` : ''}</span></label>`;
}

function metric(label, value, detail = '') {
  return `<article class="parser-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</article>`;
}

function connectionCard(title, connected, copy, actionTab) {
  return `<article class="parser-connection" data-connected="${connected}"><div><span class="parser-connection-dot"></span><strong>${escapeHtml(title)}</strong></div><p>${escapeHtml(copy)}</p><button type="button" class="parser-text-button" data-tab="${actionTab}">${connected ? 'Manage' : 'Configure'} →</button></article>`;
}

function asLines(value, fallback = []) {
  return (Array.isArray(value) ? value : fallback).join('\n');
}

export function createParserUi({
  api, showToast = () => {}, closeHistory = () => {}, confirmImpl = globalThis.confirm, storage,
} = {}) {
  const element = {
    open: document.querySelector('#parser-open'),
    workspace: document.querySelector('#parser-workspace'),
    sidebarStatus: document.querySelector('#parser-sidebar-status'),
    leadsToday: document.querySelector('#parser-leads-today'),
    hotLeads: document.querySelector('#parser-hot-leads'),
    title: document.querySelector('#conversation-title'),
    status: document.querySelector('#status'),
    statusText: document.querySelector('#status .status-text'),
  };
  if (!api || !element.open || !element.workspace) return null;

  const model = {
    active: false,
    tab: 'overview',
    status: null,
    settings: null,
    runs: { items: [], total: 0 },
    groups: { items: [], total: 0 },
    queue: { items: [], paused: false },
    monitoring: { items: [] },
    leads: { items: [], total: 0 },
    audit: { items: [], total: 0 },
    selectedGroups: new Set(),
    selectedRunIds: new Set(),
    latestDiscoveryRunId: null,
    groupStatus: 'ALL',
    activities: [],
    groupFilters: { minimumScore: 0, sort: 'score', direction: 'desc' },
    leadFilters: { class: '' },
    auditFilters: { since: '24h', limit: 200 },
    loading: false,
  };
  let refreshTimer = null;
  let eventRefreshTimer = null;
  let discoveryPreferenceLoaded = false;

  function preferenceStore() {
    try { return storage ?? globalThis.localStorage; } catch { return null; }
  }

  function saveDiscoveryPreference() {
    try {
      preferenceStore()?.setItem(DISCOVERY_VIEW_KEY, JSON.stringify({
        version: 1,
        selectedRunIds: [...model.selectedRunIds],
        status: model.groupStatus,
        latestRunId: model.latestDiscoveryRunId || preferredLatestRun(model.runs?.items || [])?.id || null,
      }));
    } catch { /* View preferences are optional. */ }
  }

  function reconcileDiscoveryPreference() {
    let saved = {
      version: 1,
      selectedRunIds: [...model.selectedRunIds],
      status: model.groupStatus,
      latestRunId: model.latestDiscoveryRunId,
    };
    if (!discoveryPreferenceLoaded) {
      try { saved = preferenceStore()?.getItem(DISCOVERY_VIEW_KEY) || null; } catch { saved = null; }
    }
    const preference = normalizeDiscoveryViewPreference(saved, model.runs.items || []);
    model.selectedRunIds = new Set(preference.selectedRunIds);
    model.groupStatus = preference.status;
    model.latestDiscoveryRunId = preference.latestRunId;
    discoveryPreferenceLoaded = true;
    saveDiscoveryPreference();
  }

  function updateSidebar() {
    const status = model.status || {};
    const state = status.state || 'SETUP_REQUIRED';
    element.open.dataset.state = state;
    element.open.classList.toggle('is-current', model.active);
    element.open.setAttribute('aria-current', model.active ? 'page' : 'false');
    if (element.sidebarStatus) element.sidebarStatus.textContent = `Lead Radar · ${parserStateLabel(state)}`;
    if (element.leadsToday) element.leadsToday.textContent = integer(status.metrics?.leadsToday);
    if (element.hotLeads) element.hotLeads.textContent = integer(status.metrics?.hotLeads);
  }

  function updateWorkspaceChrome() {
    if (!model.active) return;
    const state = model.status?.state || 'SETUP_REQUIRED';
    if (element.title) element.title.textContent = 'Parser · Telegram Lead Radar';
    if (element.status) element.status.dataset.state = stateTone(state) === 'good' ? 'ready' : stateTone(state) === 'bad' ? 'error' : 'idle';
    if (element.statusText) element.statusText.textContent = parserStateLabel(state);
  }

  function renderOverview() {
    const status = model.status || {};
    const metrics = status.metrics || {};
    const connections = status.connections || {};
    const state = status.state || 'SETUP_REQUIRED';
    const account = status.telegram || {};
    const setup = state === 'SETUP_REQUIRED' ? `<section class="parser-setup-callout">
      <div><span class="parser-kicker">FIRST RUN</span><h2>Connect a secondary Telegram account</h2><p>Discovery and monitoring stay off until the account is connected. Credentials and the Telethon session are encrypted locally with Windows DPAPI.</p></div>
      <button class="parser-primary" type="button" data-tab="settings">Open secure setup</button>
    </section>` : '';
    const events = model.activities.length
      ? model.activities.slice(0, 8).map((event) => `<li><span class="parser-activity-dot"></span><div><strong>${escapeHtml(parserEventLabel(event))}</strong><small>${escapeHtml(timeLabel(event.occurredAt))}</small></div></li>`).join('')
      : '<li class="parser-activity-empty">Operational events will appear here.</li>';
    return `${setup}<section class="parser-hero">
      <div><span class="parser-kicker">TELEGRAM LEAD RADAR</span><h1>Buyer intent, without the noise.</h1><p>Discover relevant communities, join deliberately, monitor permitted messages, and send qualified leads to your own Telegram destination.</p></div>
      <div class="parser-hero-control"><div>${badge(state)}<small>${escapeHtml(account.displayName || account.phoneMasked || 'Secondary account not connected')}</small></div>
        <button class="${state === 'RUNNING' ? 'parser-secondary' : 'parser-primary'}" type="button" data-action="${state === 'RUNNING' ? 'stop-parser' : 'start-parser'}"${state === 'SETUP_REQUIRED' ? ' disabled' : ''}>${state === 'RUNNING' ? 'Stop monitoring' : 'Start Parser'}</button></div>
    </section>
    <section class="parser-metric-grid">${metric('Groups discovered', integer(metrics.groupsDiscovered), 'deduplicated')}${metric('Groups joined', integer(metrics.groupsJoined), 'secondary account')}${metric('Monitoring', integer(metrics.groupsMonitored), 'enabled groups')}${metric('Messages today', integer(metrics.messagesProcessedToday), `${integer(metrics.messagesPerMinute)}/min`)}${metric('Candidates', integer(metrics.candidateMessages), `${integer(metrics.candidatesPerMinute)}/min · ${integer(metrics.aiQueue)} queued`)}${metric('Leads today', integer(metrics.leadsToday), `${integer(metrics.hotLeads)} hot`)}${metric('Join queue', integer(status.joinQueue?.total), status.joinQueue?.paused ? 'paused' : 'ready')}${metric('AI & delivery', `${integer(metrics.aiLatencyMs)} ms`, `${integer(metrics.notificationFailures)} notification failures`)}</section>
    <section class="parser-section"><div class="parser-section-heading"><div><span class="parser-kicker">CONNECTIONS</span><h2>Signal chain</h2></div></div><div class="parser-connection-grid">
      ${connectionCard('Telegram account', Boolean(connections.telegram), connections.telegram ? account.displayName || account.phoneMasked || 'Connected' : 'Required for discovery and monitoring', 'settings')}
      ${connectionCard('OpenRouter AI', Boolean(connections.ai), connections.ai ? status.settings?.aiModel || 'Structured classifier ready' : 'Optional second-stage BUYER classifier', 'settings')}
      ${connectionCard('Notification bot', Boolean(connections.notificationBot), connections.notificationBot ? 'Delivery destination configured' : 'Sends leads only to your configured destination', 'settings')}
    </div></section>
    <section class="parser-section parser-pipeline"><div class="parser-section-heading"><div><span class="parser-kicker">PIPELINE</span><h2>From community to qualified lead</h2></div></div><ol><li><b>01</b><strong>Discover</strong><small>Keyword queries</small></li><li><b>02</b><strong>Analyze</strong><small>Score & select</small></li><li><b>03</b><strong>Monitor</strong><small>Cheap filters first</small></li><li><b>04</b><strong>Detect</strong><small>Structured AI</small></li><li><b>05</b><strong>Notify</strong><small>Main account only</small></li></ol><p>No auto-DM. Suggested replies are never sent automatically.</p></section>
    <section class="parser-section"><div class="parser-section-heading"><div><span class="parser-kicker">JARVIS ACTIVITY</span><h2>Recent operations</h2></div></div><ol class="parser-activity-list">${events}</ol></section>`;
  }

  function renderFind() {
    const run = model.status?.discovery;
    const running = run?.status === 'RUNNING';
    const resumable = ['PAUSED', 'FAILED'].includes(run?.status);
    const telegramConnected = model.status?.connections?.telegram === true;
    const progress = run ? Math.round((integer(run.currentIndex) / Math.max(1, integer(run.totalQueries))) * 100) : 0;
    return `<section class="parser-page-intro"><div><span class="parser-kicker">DISCOVERY</span><h1>Find public communities</h1><p>Queries run one by one with persisted progress, deduplication, and Telegram rate limits left intact.</p></div>${run ? badge(run.status) : ''}</section>
    ${telegramConnected ? '' : '<div class="parser-notice" data-tone="warn"><strong>Connect Telegram before discovery.</strong><span>The search stays disabled until a secondary account is connected in Settings.</span><button class="parser-secondary" type="button" data-tab="settings">Open settings</button></div>'}
    <div class="parser-split"><form class="parser-card parser-form" data-form="discovery"><div class="parser-card-heading"><div><h2>Search themes</h2><p>One focused phrase per line or comma. Up to 100 queries.</p></div></div><label class="parser-field"><span>Keywords & themes</span><textarea name="queries" rows="12" placeholder="saas founders\nrestaurant owners\nshopify community" required></textarea><small>Searches use Telegram’s own public contacts search.</small></label><div class="parser-form-actions"><button class="parser-primary" type="submit"${running || !telegramConnected ? ' disabled' : ''}>Start discovery</button>${running ? '<button class="parser-secondary" type="button" data-action="stop-discovery">Stop</button>' : ''}${resumable ? `<button class="parser-secondary" type="button" data-action="resume-discovery"${telegramConnected ? '' : ' disabled'}>Resume saved run</button>` : ''}</div></form>
    <section class="parser-card parser-progress-card"><div class="parser-card-heading"><div><h2>Latest run</h2><p>${run ? escapeHtml(discoveryRunSummary(run)) : 'No discovery run yet'}</p></div></div>${run ? `<div class="parser-progress"><span style="width:${progress}%"></span></div><dl class="parser-fact-list"><div><dt>Progress</dt><dd>${integer(run.currentIndex)} / ${integer(run.totalQueries)}</dd></div><div><dt>Duplicates removed</dt><dd>${integer(run.duplicatesRemoved)}</dd></div><div><dt>Errors</dt><dd>${integer(run.errors)}</dd></div><div><dt>Started</dt><dd>${escapeHtml(timeLabel(run.startedAt))}</dd></div><div><dt>Elapsed</dt><dd>${escapeHtml(elapsedLabel(run.startedAt, run.completedAt))}</dd></div><div><dt>Updated</dt><dd>${escapeHtml(timeLabel(run.updatedAt))}</dd></div></dl>` : emptyState('Ready for the first query', 'Connect Telegram, add focused themes, and start discovery.')}</section></div>`;
  }

  function renderDiscovered() {
    const items = model.groups?.items || [];
    const eligibleItems = items.filter(eligibleGroup);
    const bulkDisabled = eligibleItems.length ? '' : ' disabled';
    const rows = items.map((group) => renderDiscoveredGroupRow(group, model.selectedGroups.has(group.id))).join('');
    const statusOptions = ['ALL', 'NEW', 'QUEUED', 'JOINED', 'MONITORING'].map((status) => `<option value="${status}"${model.groupStatus === status ? ' selected' : ''}>${status === 'ALL' ? 'All statuses' : status[0] + status.slice(1).toLowerCase()}</option>`).join('');
    const tableOrEmpty = model.selectedRunIds.size === 0
      ? emptyState('No discovery runs selected', 'Choose one or more runs above to review their groups.', '<button class="parser-primary" type="button" data-action="latest-run-only">Show latest run</button>')
      : items.length
        ? `<div class="parser-table-wrap"><table class="parser-table"><thead><tr><th><input type="checkbox" data-select-all aria-label="Select all visible new groups" /></th><th>Group</th><th>Members</th><th>Type</th><th>Language</th><th>Topic</th><th>Activity</th><th>Group score</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : emptyState('No groups in this view', 'Change the selected runs, lifecycle, or filters.', '<button class="parser-primary" type="button" data-tab="find">Find groups</button>');
    return `<section class="parser-page-intro"><div><span class="parser-kicker">DISCOVERED GROUPS</span><h1>Rank before you join.</h1><p>The preliminary score favors relevant groups and supergroups; observed activity and spam ratios raise confidence after monitoring.</p></div><div class="parser-page-actions"><button class="parser-primary" type="button" data-action="queue-selected"${model.selectedGroups.size ? '' : ' disabled'}>Add ${model.selectedGroups.size || ''} to queue</button></div></section>
    ${renderDiscoveryRunsPanel(model.runs?.items || [], model.selectedRunIds)}
    <div class="parser-discovery-toolbar"><label><span>Lifecycle</span><select data-group-status aria-label="Filter groups by lifecycle">${statusOptions}</select></label><span>${integer(model.groups?.total)} groups in view</span></div>
    <div class="parser-bulkbar" role="group" aria-label="Group selection"><button class="parser-secondary" type="button" data-action="select-groups" data-mode="recommended"${bulkDisabled}>Select recommended</button><button class="parser-secondary" type="button" data-action="select-groups" data-mode="90"${bulkDisabled}>Select score 90+</button><button class="parser-secondary" type="button" data-action="select-groups" data-mode="80"${bulkDisabled}>Select score 80+</button><button class="parser-secondary" type="button" data-action="select-groups" data-mode="all"${bulkDisabled}>Select all visible</button><button class="parser-text-button" type="button" data-action="select-groups" data-mode="none"${bulkDisabled}>Deselect all</button></div>
    <form class="parser-filterbar" data-form="group-filters"><input name="search" type="search" placeholder="Search title or username" value="${escapeHtml(model.groupFilters.search || '')}" /><input name="minimumMembers" type="number" min="0" placeholder="Min members" value="${escapeHtml(model.groupFilters.minimumMembers || '')}" /><input name="minimumScore" type="number" min="0" max="100" placeholder="Min score" value="${escapeHtml(model.groupFilters.minimumScore || '')}" /><input name="minimumActivity" type="number" min="0" max="100" placeholder="Min activity" value="${escapeHtml(model.groupFilters.minimumActivity || '')}" /><input name="topic" type="search" placeholder="Topic" value="${escapeHtml(model.groupFilters.topic || '')}" /><select name="language"><option value="">All languages</option><option value="en"${model.groupFilters.language === 'en' ? ' selected' : ''}>English</option><option value="ru"${model.groupFilters.language === 'ru' ? ' selected' : ''}>Russian</option><option value="mixed"${model.groupFilters.language === 'mixed' ? ' selected' : ''}>Mixed</option></select><select name="type"><option value="">All types</option><option value="supergroup"${model.groupFilters.type === 'supergroup' ? ' selected' : ''}>Supergroups</option><option value="group"${model.groupFilters.type === 'group' ? ' selected' : ''}>Groups</option><option value="channel"${model.groupFilters.type === 'channel' ? ' selected' : ''}>Channels</option></select><select name="sort"><option value="score">Score</option><option value="members"${model.groupFilters.sort === 'members' ? ' selected' : ''}>Members</option><option value="activity"${model.groupFilters.sort === 'activity' ? ' selected' : ''}>Activity</option><option value="date"${model.groupFilters.sort === 'date' ? ' selected' : ''}>Newest</option><option value="name"${model.groupFilters.sort === 'name' ? ' selected' : ''}>Name</option></select><button class="parser-secondary" type="submit">Apply</button></form>
    ${tableOrEmpty}`;
  }

  function renderQueue() {
    const queue = model.queue || { items: [] };
    const items = queue.items || [];
    const rows = items.map((item, index) => `<tr><td><span class="parser-queue-index">${String(index + 1).padStart(2, '0')}</span></td><td><div class="parser-table-title"><strong>${escapeHtml(item.title)}</strong><small>${item.username ? `@${escapeHtml(item.username)}` : escapeHtml(item.telegramGroupId)}</small></div></td><td>${integer(item.score)}</td><td>${badge(item.status)}</td><td>${integer(item.attempts)}</td><td>${item.nextAttemptAt ? escapeHtml(timeLabel(item.nextAttemptAt)) : '—'}</td><td>${renderQueueRemoveAction(item)}</td></tr>`).join('');
    const flood = queue.resumeAt ? `<div class="parser-notice" data-tone="warn"><strong>Telegram FLOOD_WAIT is active.</strong><span>Queue remains paused until ${escapeHtml(timeLabel(queue.resumeAt))}; the wait is never shortened or bypassed.</span></div>` : '';
    const queueControl = items.length ? (queue.paused ? '<button class="parser-primary" type="button" data-action="resume-queue">Resume queue</button>' : '<button class="parser-secondary" type="button" data-action="pause-queue">Pause queue</button>') : '';
    const completed = Number.isInteger(queue.completedCount) ? queue.completedCount : completedQueueCount(items);
    return `<section class="parser-page-intro"><div><span class="parser-kicker">JOIN QUEUE</span><h1>Deliberate, sequential joining.</h1><p>One group at a time, with a configurable delay and a persisted queue that survives restarts.</p></div><div class="parser-page-actions">${queueControl}${renderQueueClearButton(completed)}</div></section>${flood}${items.length ? `<div class="parser-table-wrap"><table class="parser-table"><thead><tr><th>#</th><th>Group</th><th>Score</th><th>Status</th><th>Attempts</th><th>Next action</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('Join queue is empty', 'Choose relevant groups from Discovered and add them here.', '<button class="parser-primary" type="button" data-tab="discovered">Review discovered groups</button>')}`;
  }

  function renderMonitoring(monitoring = {}, status = {}) {
    const items = monitoring?.items || [];
    const catchUp = status?.historyCatchUp || {};
    const catchUpNotice = catchUp.state && catchUp.state !== 'IDLE'
      ? `<div class="parser-notice" data-tone="${catchUp.state === 'FAILED' ? 'warn' : 'info'}"><strong>History catch-up: ${escapeHtml(catchUp.state)}</strong><span>${integer(catchUp.processed)} processed · ${integer(catchUp.scanned)} scanned${catchUp.errorCode ? ` · ${escapeHtml(catchUp.errorCode)}` : ''}</span></div>`
      : '';
    const rows = items.map((group) => `<tr><td><div class="parser-table-title"><strong>${escapeHtml(group.title)}</strong><small>${group.username ? `@${escapeHtml(group.username)}` : escapeHtml(group.telegramGroupId)}</small></div></td><td>${badge(group.enabled ? 'MONITORING' : 'STOPPED')}</td><td>${integer(group.messagesToday)}</td><td>${integer(group.messagesTotal)}</td><td>${integer(group.candidatesToday)}</td><td>${integer(group.candidatesTotal)}</td><td>${integer(group.leadsToday)}</td><td>${integer(group.leadsTotal)}</td><td>${escapeHtml(timeLabel(group.lastMessageAt))}</td><td>${escapeHtml(timeLabel(group.lastLeadAt))}</td><td>${escapeHtml(timeLabel(group.historyCursorAt))}</td><td>${escapeHtml(group.lastError || '—')}</td><td>${badge(group.status || (group.enabled ? 'MONITORING' : 'JOINED'))}</td><td><div class="parser-row-actions"><button class="parser-text-button" type="button" data-action="toggle-monitoring" data-id="${escapeHtml(group.groupId)}" data-enabled="${group.enabled}">${group.enabled ? 'Stop monitoring' : 'Start monitoring'}</button><button class="parser-text-button danger" type="button" data-action="leave-group" data-id="${escapeHtml(group.groupId)}" data-title="${escapeHtml(group.title)}">Leave group</button></div></td></tr>`).join('');
    return `<section class="parser-page-intro"><div><span class="parser-kicker">MONITORING</span><h1>Listen only where you chose.</h1><p>Daily numbers reset at UTC midnight. Total numbers are retained from the start of durable tracking. Stopping monitoring keeps the account in the group.</p></div></section>${catchUpNotice}${items.length ? `<div class="parser-table-wrap"><table class="parser-table"><thead><tr><th>Group</th><th>Monitoring</th><th>Messages today</th><th>Messages total</th><th>Candidates today</th><th>Candidates total</th><th>Leads today</th><th>Leads total</th><th>Last message</th><th>Last lead</th><th>History synced through</th><th>Last error</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('No monitored groups', 'Joined groups appear here automatically and can be stopped without leaving.', '<button class="parser-primary" type="button" data-tab="queue">Open join queue</button>')}`;
  }

  function renderFilters() {
    const settings = model.settings || model.status?.settings || {};
    const categories = [
      ['WEBSITES', 'Websites & landing pages'], ['WEB_APPLICATIONS', 'Web applications, SaaS & MVP'],
      ['BACKEND', 'Backend & Python'], ['FULL_STACK', 'Full-stack, frontend & web engineering'],
      ['API_INTEGRATIONS', 'API, CRM & integrations'], ['TELEGRAM', 'Telegram bots & Mini Apps'],
      ['AUTOMATION', 'Automation & workflows'], ['ADMIN_TOOLS', 'Admin & internal tools'],
      ['PAYMENTS_COMMERCE', 'Payments & commerce engineering'], ['DESIGN', 'Design'],
      ['MARKETING', 'Marketing'], ['MOBILE', 'Mobile development'],
    ];
    const enabled = new Set(settings.enabledLeadCategories || []);
    const categoryChecks = categories.map(([id, label]) => checkbox(`category-${id}`, label, enabled.has(id))).join('');
    return `<section class="parser-page-intro"><div><span class="parser-kicker">LEAD FILTERS</span><h1>Context first. AI makes the final decision.</h1><p>The built-in, versioned RU/EN/RO vocabulary matches request, hiring, project, service and negative signals with word boundaries. It never sends a notification for a bare word such as “need”, “Django”, or “бот”.</p></div></section><form class="parser-settings-grid" data-form="lead-filters">
      <section class="parser-card parser-form"><div class="parser-card-heading"><div><h2>Enabled work categories</h2><p>Only these service directions can reach AI by default. Paid vacancies are included; ads and job-seeker posts are not notified.</p></div></div>${categoryChecks}</section>
      <section class="parser-card parser-form"><div class="parser-card-heading"><div><h2>Context boundaries</h2><p>Nearby request and service evidence can connect naturally, but distant chat text cannot create a lead.</p></div></div>${settingField('maxSignalDistanceChars', 'Maximum signal distance (characters)', settings.maxSignalDistanceChars ?? 240, { type: 'number', min: 40, max: 1000 })}${settingField('maxContextWindowChars', 'Maximum context window (characters)', settings.maxContextWindowChars ?? 360, { type: 'number', min: 80, max: 2000 })}${settingField('sameAuthorContextMessageLimit', 'Previous messages from same author', settings.sameAuthorContextMessageLimit ?? 2, { type: 'number', min: 0, max: 5 })}${settingField('sameAuthorContextTimeWindowSeconds', 'Same-author context window (seconds)', settings.sameAuthorContextTimeWindowSeconds ?? 1200, { type: 'number', min: 60, max: 7200 })}</section>
      <section class="parser-card parser-form"><div class="parser-card-heading"><div><h2>Audit and review</h2><p>Every delivery has a route. Qualified client and hiring leads notify immediately; MAYBE_LEAD stays in Audit for manual review.</p></div></div>${settingField('diagnosticRawRetentionDays', 'Raw diagnostic retention (days)', settings.diagnosticRawRetentionDays ?? 7, { type: 'number', min: 1, max: 90 })}</section>
      <div class="parser-form-footer"><button class="parser-primary" type="submit">Save qualification settings</button><span>Vocabulary changes are versioned in the application; these settings affect new messages only.</span></div></form>`;
  }

  function renderLeads() {
    const items = model.leads?.items || [];
    const cards = items.map((lead) => {
      const original = safeOriginalUrl(lead.originalMessageUrl);
      const chat = safeTelegramPeerUrl(lead.groupUsername);
      const profile = safeTelegramPeerUrl(lead.authorUsername);
      const author = lead.authorUsername ? `@${lead.authorUsername}` : lead.authorName || 'Unknown author';
      const leadType = lead.aiClass || 'CLIENT_LEAD';
      const temperature = leadType === 'HIRING_LEAD' ? 'HIRING' : 'CLIENT';
      const sourceAction = original
        ? `<a class="parser-primary" href="${escapeHtml(original)}" target="_blank" rel="noreferrer">Open message ↗</a>`
        : chat
          ? `<a class="parser-secondary" href="${escapeHtml(chat)}" target="_blank" rel="noreferrer">Open chat · message #${integer(lead.messageId)}</a>`
          : `<span class="parser-link-unavailable">Private chat · message #${integer(lead.messageId)}</span>`;
      return `<article class="parser-lead-card"><header><div><span class="parser-lead-temperature" data-level="${temperature}">${temperature} LEAD</span><h2>${escapeHtml(lead.detectedNeed || 'Development request')}</h2></div><span class="parser-lead-score">${integer(lead.score)}<small>/100</small></span></header><div class="parser-lead-meta"><span>${escapeHtml(lead.groupTitle || lead.telegramGroupId)}</span><span>${escapeHtml(author)}</span><span>AI: ${escapeHtml(lead.aiClass || 'BUYER')}</span><span>${escapeHtml(timeLabel(lead.messageTimestamp))}</span>${badge(lead.notificationStatus)}</div><blockquote>${escapeHtml(lead.messageText)}</blockquote><p class="parser-lead-reason"><strong>Why it qualified</strong>${escapeHtml(lead.reason || 'Buyer intent detected')}</p>${lead.suggestedReply ? `<div class="parser-suggested"><span>Suggested reply · manual only</span><p>${escapeHtml(lead.suggestedReply)}</p><button class="parser-secondary" type="button" data-action="copy-reply" data-reply="${escapeHtml(lead.suggestedReply)}">Copy suggested reply</button></div>` : ''}<footer><div class="parser-row-actions">${sourceAction}${profile ? `<a class="parser-text-button" href="${escapeHtml(profile)}" target="_blank" rel="noreferrer">Open profile</a>` : ''}</div><div class="parser-row-actions"><button class="parser-icon-action good" type="button" data-action="feedback" data-id="${escapeHtml(lead.id)}" data-verdict="GOOD" title="Mark good">✓</button><button class="parser-icon-action" type="button" data-action="feedback" data-id="${escapeHtml(lead.id)}" data-verdict="BAD" title="Mark bad">×</button>${lead.authorId ? `<button class="parser-text-button" type="button" data-action="ignore-author" data-id="${escapeHtml(lead.id)}" data-author="${escapeHtml(lead.authorId)}">Ignore author</button>` : ''}<button class="parser-text-button" type="button" data-action="ignore-chat" data-id="${escapeHtml(lead.id)}" data-chat="${escapeHtml(lead.telegramGroupId)}">Ignore chat</button></div></footer></article>`;
    }).join('');
    return `<section class="parser-page-intro"><div><span class="parser-kicker">QUALIFIED LEADS</span><h1>Human context, ready for review.</h1><p>Every lead is persisted before notification. Any response to the author remains a manual human action.</p></div></section><form class="parser-filterbar" data-form="lead-list-filters"><input name="minimumScore" type="number" min="0" max="100" value="${escapeHtml(model.leadFilters.minimumScore ?? 70)}" aria-label="Minimum score" /><select name="class"><option value="">All classes</option><option value="BUYER">BUYER</option></select><button class="parser-secondary" type="submit">Apply</button></form><div class="parser-lead-list">${cards || emptyState('No qualified leads yet', 'Once monitoring is running, qualified BUYER messages will appear here.', '<button class="parser-primary" type="button" data-tab="overview">Review setup</button>')}</div>`;
  }

  function auditText(item) {
    if (item.originalText) return item.originalText;
    if (item.contentType === 'media_without_text') return 'Media without textual content.';
    return 'Source text was compacted after the diagnostic retention period.';
  }

  function renderAudit() {
    const items = model.audit?.items || [];
    const cards = items.map((item) => {
      const group = item.chat_title || item.telegram_group_id || 'Unknown group';
      const author = item.author_username ? `@${item.author_username}` : item.author_name || 'Unknown author';
      const outcome = item.aiOutcome || item.aiState || 'NOT_QUALIFIED';
      const signalSummary = (item.matchedSignals || []).slice(0, 3)
        .map((signal) => signal.canonicalConcept || signal.variant || signal.signalType)
        .filter(Boolean).join(' · ');
      return `<article class="parser-lead-card"><header><div><span class="parser-lead-temperature" data-level="MAYBE">${escapeHtml(item.gate || 'UNKNOWN')}</span><h2>${escapeHtml(outcome)}</h2></div><span class="parser-lead-score">r${integer(item.revision || 1)}</span></header><div class="parser-lead-meta"><span>${escapeHtml(group)}</span><span>${escapeHtml(author)}</span><span>AI: ${escapeHtml(item.aiState || 'AI_NOT_REQUIRED')}</span><span>${escapeHtml(timeLabel(item.message_timestamp || item.receivedAt))}</span>${badge(item.notificationState || 'NOT_REQUIRED')}${item.feedbackState ? badge(item.feedbackState) : ''}</div><blockquote>${escapeHtml(auditText(item))}</blockquote><p class="parser-lead-reason"><strong>Decision route</strong>${escapeHtml(item.gateReason || 'No route reason recorded.')}${signalSummary ? `<br><strong>Signals</strong>${escapeHtml(signalSummary)}` : ''}</p><footer><div class="parser-row-actions"><button class="parser-text-button" type="button" data-action="audit-feedback" data-id="${escapeHtml(item.id)}" data-verdict="correct_lead">Correct lead</button><button class="parser-text-button" type="button" data-action="audit-feedback" data-id="${escapeHtml(item.id)}" data-verdict="not_a_lead">Not a lead</button><button class="parser-text-button" type="button" data-action="audit-feedback" data-id="${escapeHtml(item.id)}" data-verdict="maybe_uncertain">Uncertain</button></div></footer></article>`;
    }).join('');
    const filters = model.auditFilters || {};
    return `<section class="parser-page-intro"><div><span class="parser-kicker">DECISION HISTORY</span><h1>Every message has an auditable route.</h1><p>Use this view to inspect missed candidates, AI failures, and notification delivery without exposing retained text after its configured expiry.</p></div></section><form class="parser-filterbar" data-form="audit-filters"><select name="since" aria-label="Time range"><option value="24h"${filters.since === '24h' ? ' selected' : ''}>Last 24 hours</option><option value="48h"${filters.since === '48h' ? ' selected' : ''}>Last 48 hours</option><option value="7d"${filters.since === '7d' ? ' selected' : ''}>Last 7 days</option></select><select name="gate" aria-label="Decision route"><option value="">All routes</option><option value="STRONG_CONTEXT_GATE"${filters.gate === 'STRONG_CONTEXT_GATE' ? ' selected' : ''}>Strong context</option><option value="WEAK_SEMANTIC_GATE"${filters.gate === 'WEAK_SEMANTIC_GATE' ? ' selected' : ''}>Weak context</option><option value="NO_CONTEXT_GATE"${filters.gate === 'NO_CONTEXT_GATE' ? ' selected' : ''}>No context</option><option value="NEGATIVE_GATE"${filters.gate === 'NEGATIVE_GATE' ? ' selected' : ''}>Negative gate</option></select><select name="outcome" aria-label="AI outcome"><option value="">All outcomes</option><option value="CLIENT_LEAD"${filters.outcome === 'CLIENT_LEAD' ? ' selected' : ''}>Client lead</option><option value="HIRING_LEAD"${filters.outcome === 'HIRING_LEAD' ? ' selected' : ''}>Hiring lead</option><option value="MAYBE_LEAD"${filters.outcome === 'MAYBE_LEAD' ? ' selected' : ''}>Maybe lead</option><option value="SELLER_AD"${filters.outcome === 'SELLER_AD' ? ' selected' : ''}>Seller ad</option><option value="JOB_SEEKER"${filters.outcome === 'JOB_SEEKER' ? ' selected' : ''}>Job seeker</option></select><label class="parser-check"><input name="potentialMissed" type="checkbox"${filters.potentialMissed ? ' checked' : ''} /> Potentially missed</label><button class="parser-secondary" type="submit">Apply</button></form><div class="parser-lead-list">${cards || emptyState('No audit records for this filter', 'New and historical Telegram deliveries will appear here with their decision route.', '<button class="parser-primary" type="button" data-tab="monitoring">Review monitoring</button>')}</div>`;
  }

  function renderSettings() {
    const settings = model.settings || model.status?.settings || {};
    const account = model.status?.telegram || {};
    const waiting = ['WAITING_FOR_CODE', 'WAITING_FOR_2FA', 'CONNECTING'].includes(account.state);
    return `<section class="parser-page-intro"><div><span class="parser-kicker">SETTINGS</span><h1>Connections & operating limits</h1><p>Sensitive values are never returned to the browser after saving. The Telegram 2FA password is used once and never stored.</p></div>${badge(account.state || 'DISCONNECTED')}</section><div class="parser-settings-stack">
    <form class="parser-card parser-form" data-form="telegram-connect"><input class="visually-hidden" type="text" name="credentialIdentity" value="telegram-api" autocomplete="username" tabindex="-1" aria-hidden="true" /><div class="parser-card-heading"><div><h2>Telegram account</h2><p>One secondary user account for discovery, joining, and permitted message monitoring.</p></div><span>${escapeHtml(account.displayName || account.phoneMasked || '')}</span></div><div class="parser-form-grid">${settingField('apiId', 'Telegram API ID', settings.telegramApiId || '', { type: 'number', min: 1, max: 2147483647 })}${settingField('apiHash', 'Telegram API Hash', '', { type: 'password', placeholder: settings.hasTelegramApiHash ? 'Saved securely · enter to replace' : '32-character API hash', autocomplete: 'new-password' })}${settingField('phone', 'Phone number', '', { placeholder: account.phoneMasked || '+373…', autocomplete: 'tel' })}</div><div class="parser-form-actions"><button class="parser-primary" type="submit"${account.state === 'CONNECTED' ? ' disabled' : ''}>Send code</button>${account.state !== 'CONNECTED' && settings.hasTelegramSession ? '<button class="parser-secondary" type="button" data-action="reconnect-telegram">Reconnect Telegram</button>' : ''}${account.state === 'CONNECTED' ? '<button class="parser-secondary danger" type="button" data-action="disconnect-telegram">Disconnect account</button>' : ''}</div></form>
    ${waiting ? `<form class="parser-card parser-form" data-form="telegram-verify"><input class="visually-hidden" type="text" name="credentialIdentity" value="telegram-account" autocomplete="username" tabindex="-1" aria-hidden="true" /><div class="parser-card-heading"><div><h2>Complete Telegram login</h2><p>Enter the code from Telegram. Add the 2FA password only if requested.</p></div>${badge(account.state)}</div><div class="parser-form-grid">${settingField('code', 'Telegram code', '', { placeholder: '12345', autocomplete: 'one-time-code' })}${settingField('password', '2FA password', '', { type: 'password', placeholder: 'Used once · never stored', autocomplete: 'current-password' })}</div><div class="parser-form-actions"><button class="parser-primary" type="submit">Connect</button></div></form>` : ''}
    <form class="parser-card parser-form" data-form="ai-settings"><input class="visually-hidden" type="text" name="credentialIdentity" value="openrouter" autocomplete="username" tabindex="-1" aria-hidden="true" /><div class="parser-card-heading"><div><h2>OpenRouter AI classifier</h2><p>Strict JSON schema distinguishes BUYER from sellers, jobs, hiring, discussion, and spam.</p></div>${badge(settings.aiEnabled ? 'ENABLED' : 'OPTIONAL', settings.aiEnabled ? 'good' : 'quiet')}</div><div class="parser-form-grid">${settingField('aiModel', 'Model', settings.aiModel || '', { placeholder: 'provider/model-name' })}${settingField('openrouterKey', 'OpenRouter key', '', { type: 'password', placeholder: settings.hasOpenRouterKey ? 'Saved securely · enter to replace' : 'sk-or-…', autocomplete: 'new-password' })}</div>${checkbox('aiEnabled', 'Enable AI qualification', Boolean(settings.aiEnabled), 'Fast filters and dedup still run before any provider request.')}<div class="parser-form-actions"><button class="parser-primary" type="submit">Save AI settings</button><button class="parser-secondary" type="button" data-action="test-ai">Test AI</button></div></form>
    <form class="parser-card parser-form" data-form="notification-settings"><input class="visually-hidden" type="text" name="credentialIdentity" value="telegram-bot" autocomplete="username" tabindex="-1" aria-hidden="true" /><div class="parser-card-heading"><div><h2>Notification Bot</h2><p>BotFather bot sends lead notifications only to this configured destination.</p></div>${badge(settings.hasBotToken && settings.hasDestinationId ? 'CONFIGURED' : 'NOT CONFIGURED', settings.hasBotToken && settings.hasDestinationId ? 'good' : 'quiet')}</div><div class="parser-form-grid">${settingField('botToken', 'Bot token', '', { type: 'password', placeholder: settings.hasBotToken ? 'Saved securely · enter to replace' : '123456:ABC…', autocomplete: 'new-password' })}${settingField('destinationId', 'Main account / destination ID', '', { placeholder: settings.hasDestinationId ? 'Saved securely · enter to replace' : 'Telegram numeric chat ID' })}</div><div class="parser-form-actions"><button class="parser-primary" type="submit">Save notification settings</button><button class="parser-secondary" type="button" data-action="test-notification">Send test notification</button></div></form>
    <form class="parser-card parser-form" data-form="operating-settings"><div class="parser-card-heading"><div><h2>Discovery, monitoring & startup</h2><p>Conservative defaults protect the account and keep local storage bounded. Join Queue resumes itself after Telegram’s full FLOOD_WAIT.</p></div></div><div class="parser-form-grid">${settingField('discoveryLimitPerQuery', 'Results per query', settings.discoveryLimitPerQuery ?? 50, { type: 'number', min: 1, max: 100 })}${settingField('discoveryDelayMs', 'Delay between queries (ms)', settings.discoveryDelayMs ?? 3000, { type: 'number', min: 500, max: 60000 })}${settingField('joinDelaySeconds', 'Delay between joins (seconds)', settings.joinDelaySeconds ?? 90, { type: 'number', min: 15, max: 86400 })}${settingField('retentionDays', 'Irrelevant candidate retention (days)', settings.retentionDays ?? 30, { type: 'number', min: 1, max: 365 })}</div>${checkbox('autoStart', 'Restore running state after JARVIS restart', Boolean(settings.autoStart), 'Starts only when the saved Telegram session is valid.')}<div class="parser-form-actions"><button class="parser-primary" type="submit">Save operating settings</button></div></form></div>`;
  }

  function renderBody() {
    if (model.loading) return '<div class="parser-loading" role="status"><span></span>Loading live Parser data…</div>';
    if (model.tab === 'find') return renderFind();
    if (model.tab === 'discovered') return renderDiscovered();
    if (model.tab === 'queue') return renderQueue();
    if (model.tab === 'monitoring') return renderMonitoring(model.monitoring, model.status);
    if (model.tab === 'filters') return renderFilters();
    if (model.tab === 'leads') return renderLeads();
    if (model.tab === 'audit') return renderAudit();
    if (model.tab === 'settings') return renderSettings();
    return renderOverview();
  }

  function render({ preserveScroll = false } = {}) {
    if (!model.active) return;
    updateSidebar();
    updateWorkspaceChrome();
    const html = `<header class="parser-workspace-header"><div class="parser-wordmark"><span>P</span><div><strong>Parser</strong><small>Telegram Lead Radar</small></div></div><nav class="parser-tabs" aria-label="Parser sections">${TABS.map(([id, label]) => `<button type="button" data-tab="${id}"${model.tab === id ? ' class="is-active" aria-current="page"' : ''}>${label}</button>`).join('')}</nav></header><div class="parser-workspace-scroll"><div class="parser-workspace-content">${renderBody()}</div></div>`;
    if (preserveScroll) replaceParserWorkspace(element.workspace, html);
    else element.workspace.innerHTML = html;
  }

  async function load(tab = model.tab, {
    spinner = true,
    preserveScroll = shouldPreserveParserWorkspaceScroll(tab, {
      spinner,
      sameTab: tab === model.tab,
    }),
  } = {}) {
    model.tab = tab;
    if (spinner) { model.loading = true; render(); }
    try {
      model.status = await api.parserStatus();
      if (tab === 'discovered') {
        model.runs = await api.parserDiscoveryRuns({ limit: 100, offset: 0 });
        reconcileDiscoveryPreference();
        const request = discoveryGroupRequest(model.selectedRunIds, model.groupStatus, model.groupFilters);
        model.groups = request ? await api.parserGroups(request) : { items: [], total: 0 };
        model.selectedGroups = reconcileSelectedGroups(model.selectedGroups, model.groups.items || []);
      }
      if (tab === 'queue') model.queue = await api.parserQueue();
      if (tab === 'monitoring') model.monitoring = await api.parserMonitoring();
      if (tab === 'leads') model.leads = await api.parserLeads(model.leadFilters);
      if (tab === 'audit') model.audit = await api.parserAudit(model.auditFilters);
      if (tab === 'settings' || tab === 'filters') model.settings = await api.parserSettings();
    } catch (error) {
      showToast(error.message);
      if (model.active) element.workspace.innerHTML = `<div class="parser-error-state"><span>!</span><h2>Parser data is temporarily unavailable</h2><p>${escapeHtml(error.message)}</p><button class="parser-primary" type="button" data-action="retry">Retry</button></div>`;
      return;
    } finally {
      model.loading = false;
      updateSidebar();
    }
    render({ preserveScroll });
  }

  async function refreshSidebar() {
    try {
      model.status = await api.parserStatus();
      updateSidebar();
      updateWorkspaceChrome();
    } catch {
      if (model.status) model.status = { ...model.status, state: 'DEGRADED' };
      else model.status = { state: 'DEGRADED', metrics: {} };
      updateSidebar();
    }
  }

  function open(tab = model.tab) {
    model.active = true;
    model.tab = tab;
    document.body.classList.add('parser-view-active');
    element.workspace.hidden = false;
    closeHistory();
    updateSidebar();
    void load(tab);
  }

  function close() {
    if (!model.active) return;
    model.active = false;
    document.body.classList.remove('parser-view-active');
    element.workspace.hidden = true;
    updateSidebar();
  }

  async function runAction(action, button) {
    const id = button?.dataset.id;
    button?.setAttribute('disabled', '');
    try {
      if (action === 'retry') return load(model.tab);
      if (action === 'start-parser') await api.parserStart();
      if (action === 'stop-parser') await api.parserStop();
      if (action === 'stop-discovery') await api.parserDiscoveryStop();
      if (action === 'resume-discovery') await api.parserDiscoveryResume(model.status?.discovery?.id || '');
      if (action === 'pause-queue') await api.parserQueuePause();
      if (action === 'resume-queue') await api.parserQueueResume();
      if (action === 'clear-completed-queue') {
        const result = await clearCompletedQueueView(api);
        model.queue = result.queue;
        showToast(result.message);
        render({ preserveScroll: shouldPreserveParserWorkspaceScroll(model.tab) });
        return;
      }
      if (action === 'remove-queue') await api.parserQueueRemove(id);
      if (action === 'ignore-group') await api.parserIgnoreGroup(id);
      if (['show-all-runs', 'hide-all-runs', 'latest-run-only'].includes(action)) {
        model.selectedRunIds = runSelectionForAction(
          action, model.runs?.items || [], model.selectedRunIds,
        );
        saveDiscoveryPreference();
        await load('discovered', { spinner: false });
        return;
      }
      if (action === 'select-groups') {
        const mode = button.dataset.mode;
        model.selectedGroups.clear();
        for (const group of model.groups?.items || []) {
          const selected = eligibleGroup(group) && (mode === 'all'
            || mode === 'recommended' && group.type !== 'channel' && integer(group.score) >= 80
            || /^\d+$/.test(mode || '') && integer(group.score) >= Number(mode));
          if (selected) model.selectedGroups.add(group.id);
        }
        render({ preserveScroll: shouldPreserveParserWorkspaceScroll(model.tab) });
        return;
      }
      if (action === 'queue-selected') {
        await api.parserQueueAdd([...model.selectedGroups]);
        model.selectedGroups.clear();
        return load('queue');
      }
      if (action === 'toggle-monitoring') await api.parserMonitoringSet(id, button.dataset.enabled !== 'true');
      if (action === 'leave-group') {
        const accepted = confirmImpl?.(`Leave “${button.dataset.title || 'this group'}” with the secondary Telegram account? This also stops monitoring.`);
        if (!accepted) return;
        await api.parserLeaveGroup(id);
      }
      if (action === 'disconnect-telegram') {
        const accepted = confirmImpl?.('Disconnect the secondary Telegram account? Monitoring and Join Queue will stop. Discovered groups and leads will be preserved.');
        if (!accepted) return;
        await api.parserDisconnect();
      }
      if (action === 'reconnect-telegram') await api.parserReconnect();
      if (action === 'test-ai') { const result = await api.parserTestAi(); showToast(aiTestSuccessMessage(result)); }
      if (action === 'test-notification') { await api.parserTestNotification(); showToast('Test notification sent to the configured destination.'); }
      if (action === 'audit-feedback') { await api.parserAuditFeedback(id, button.dataset.verdict); showToast('Audit feedback saved.'); }
      if (action === 'feedback') { await api.parserLeadFeedback(id, button.dataset.verdict); showToast('Lead feedback saved.'); }
      if (action === 'ignore-author') { await api.parserIgnoreAuthor(id, button.dataset.author); showToast('Author ignored for future leads.'); }
      if (action === 'ignore-chat') { await api.parserIgnoreChat(id, button.dataset.chat); showToast('Chat ignored for future leads.'); }
      if (action === 'copy-reply') {
        await navigator.clipboard.writeText(button.dataset.reply || '');
        showToast('Suggested reply copied. Nothing was sent.');
        return;
      }
      await load(model.tab, { spinner: false });
    } catch (error) {
      showToast(error.message);
      button?.removeAttribute('disabled');
    }
  }

  async function submitForm(form) {
    const values = new FormData(form);
    const kind = form.dataset.form;
    const lines = (name) => String(values.get(name) || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const queries = (name) => String(values.get(name) || '').split(/[,\r\n]+/).map((item) => item.trim()).filter(Boolean);
    const checked = (name) => values.get(name) === 'on';
    try {
      form.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      if (kind === 'discovery') {
        const run = await api.parserDiscoveryStart(queries('queries'));
        if (run?.id) {
          model.selectedRunIds = new Set([run.id]);
          model.latestDiscoveryRunId = run.id;
          model.groupStatus = 'ALL';
          discoveryPreferenceLoaded = true;
          saveDiscoveryPreference();
        }
      }
      if (kind === 'group-filters') {
        model.groupFilters = Object.fromEntries([...values.entries()].filter(([, value]) => value !== ''));
      }
      if (kind === 'lead-list-filters') model.leadFilters = Object.fromEntries([...values.entries()].filter(([, value]) => value !== ''));
      if (kind === 'audit-filters') {
        model.auditFilters = Object.fromEntries([...values.entries()].filter(([, value]) => value !== ''));
        model.auditFilters.potentialMissed = checked('potentialMissed');
        model.auditFilters.limit = 200;
      }
      if (kind === 'telegram-connect') await api.parserSendCode(Number(values.get('apiId')), String(values.get('apiHash') || ''), String(values.get('phone') || ''));
      if (kind === 'telegram-verify') await api.parserVerify(String(values.get('code') || ''), String(values.get('password') || ''));
      if (kind === 'ai-settings') await api.saveParserSettings({ settings: { aiEnabled: checked('aiEnabled'), aiModel: String(values.get('aiModel') || '') }, openrouterKey: String(values.get('openrouterKey') || '') });
      if (kind === 'notification-settings') await api.saveParserSettings({ settings: {}, botToken: String(values.get('botToken') || ''), destinationId: String(values.get('destinationId') || '') });
      if (kind === 'operating-settings') await api.saveParserSettings({ settings: {
        discoveryLimitPerQuery: Number(values.get('discoveryLimitPerQuery')), discoveryDelayMs: Number(values.get('discoveryDelayMs')),
        joinDelaySeconds: Number(values.get('joinDelaySeconds')), retentionDays: Number(values.get('retentionDays')),
        autoStart: checked('autoStart'),
      } });
      if (kind === 'lead-filters') {
        const categories = ['WEBSITES', 'WEB_APPLICATIONS', 'BACKEND', 'FULL_STACK', 'API_INTEGRATIONS', 'TELEGRAM', 'AUTOMATION', 'ADMIN_TOOLS', 'PAYMENTS_COMMERCE', 'DESIGN', 'MARKETING', 'MOBILE']
          .filter((category) => checked(`category-${category}`));
        await api.saveParserSettings({ settings: {
          enabledLeadCategories: categories,
          maxSignalDistanceChars: Number(values.get('maxSignalDistanceChars')),
          maxContextWindowChars: Number(values.get('maxContextWindowChars')),
          sameAuthorContextMessageLimit: Number(values.get('sameAuthorContextMessageLimit')),
          sameAuthorContextTimeWindowSeconds: Number(values.get('sameAuthorContextTimeWindowSeconds')),
          diagnosticRawRetentionDays: Number(values.get('diagnosticRawRetentionDays')),
        } });
      }
      if (!['group-filters', 'lead-list-filters', 'audit-filters', 'discovery'].includes(kind)) showToast('Parser settings saved securely.');
      await load(model.tab, { spinner: false });
    } catch (error) {
      showToast(error.message);
      form.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }

  element.open.addEventListener('click', () => open());
  element.workspace.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) { void load(tab); return; }
    const button = event.target.closest('[data-action]');
    if (button) { void runAction(button.dataset.action, button); return; }
    const group = groupForDiscoveredRowEvent(event, model.groups?.items || []);
    if (group) {
      model.selectedGroups = toggleGroupSelection(model.selectedGroups, group);
      render({ preserveScroll: true });
    }
  });
  element.workspace.addEventListener('change', (event) => {
    const runCheckbox = event.target.closest('[data-run-select]');
    if (runCheckbox) {
      if (runCheckbox.checked) model.selectedRunIds.add(runCheckbox.dataset.runSelect);
      else model.selectedRunIds.delete(runCheckbox.dataset.runSelect);
      saveDiscoveryPreference();
      void load('discovered', { spinner: false });
      return;
    }
    if (event.target.matches('[data-group-status]')) {
      model.groupStatus = DISCOVERY_STATUSES.has(event.target.value) ? event.target.value : 'ALL';
      saveDiscoveryPreference();
      void load('discovered', { spinner: false });
      return;
    }
    const checkboxElement = event.target.closest('[data-group-select]');
    if (checkboxElement) {
      if (checkboxElement.checked) model.selectedGroups.add(checkboxElement.dataset.groupSelect);
      else model.selectedGroups.delete(checkboxElement.dataset.groupSelect);
      render({ preserveScroll: true });
      return;
    }
    if (event.target.matches('[data-select-all]')) {
      element.workspace.querySelectorAll('[data-group-select]').forEach((item) => {
        if (item.disabled) return;
        item.checked = event.target.checked;
        if (item.checked) model.selectedGroups.add(item.dataset.groupSelect); else model.selectedGroups.delete(item.dataset.groupSelect);
      });
      render({ preserveScroll: shouldPreserveParserWorkspaceScroll(model.tab) });
    }
  });
  element.workspace.addEventListener('keydown', (event) => {
    const group = groupForDiscoveredRowEvent(event, model.groups?.items || []);
    if (!group) return;
    model.selectedGroups = toggleGroupSelection(model.selectedGroups, group);
    render({ preserveScroll: true });
  });
  element.workspace.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitForm(event.target);
  });
  document.addEventListener('click', (event) => {
    if (!model.active) return;
    if (event.target.closest('#new-chat, #crypto-open, .history-select, .brand')) close();
  }, true);

  function handleEvent(event) {
    if (event?.type !== 'parser-activity') return;
    model.activities.unshift(event);
    model.activities.splice(40);
    if (event.eventType === 'parser_state' && event.state) model.status = { ...(model.status || {}), state: event.state };
    if (event.eventType === 'discovery_completed' && event.runId) {
      model.selectedRunIds = new Set([event.runId]);
      model.latestDiscoveryRunId = event.runId;
      model.groupStatus = 'ALL';
      discoveryPreferenceLoaded = true;
      saveDiscoveryPreference();
    }
    updateSidebar();
    if (model.active) {
      clearTimeout(eventRefreshTimer);
      eventRefreshTimer = setTimeout(() => { void load(model.tab, { spinner: false }); }, 220);
    }
  }

  void refreshSidebar();
  refreshTimer = setInterval(() => { void refreshSidebar(); }, 10_000);
  return Object.freeze({ open, close, handleEvent, refresh: () => load(model.tab, { spinner: false }), isActive: () => model.active, stop: () => clearInterval(refreshTimer) });
}
