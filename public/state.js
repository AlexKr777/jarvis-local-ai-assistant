const DRAFT_STORAGE_KEY = 'jarvis.drafts.v1';
const MAX_DRAFT_LENGTH = 8_000;

function dictionary(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function queueDictionary(value) {
  const source = dictionary(value);
  return Object.fromEntries(Object.entries(source)
    .filter(([, items]) => Array.isArray(items))
    .map(([threadId, items]) => [threadId, items.map((item) => ({ ...item }))]));
}

function safeDrafts() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(DRAFT_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([threadId, value]) => threadId && typeof value === 'string')
      .map(([threadId, value]) => [threadId, value.slice(0, MAX_DRAFT_LENGTH)]));
  } catch {
    return {};
  }
}

function writeDrafts(drafts) {
  try {
    globalThis.localStorage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

function withoutKey(source, key) {
  const next = { ...source };
  delete next[key];
  return next;
}

function upsertActivity(items, activity) {
  const current = Array.isArray(items) ? items : [];
  if (!activity?.id) return [...current, { ...activity }];
  const index = current.findIndex((item) => item.id === activity.id);
  if (index === -1) return [...current, { ...activity }];
  return current.map((item, itemIndex) => itemIndex === index ? { ...item, ...activity } : item);
}

export function createState(initial = {}) {
  const state = {
    threads: [],
    activeThreadId: null,
    details: {},
    drafts: safeDrafts(),
    streams: {},
    activities: {},
    queues: {},
    statuses: {},
    approvals: {},
    approvalQueues: {},
    ...initial,
  };
  return {
    ...state,
    threads: Array.isArray(state.threads) ? state.threads.map((thread) => ({ ...thread })) : [],
    details: dictionary(state.details),
    drafts: dictionary(state.drafts),
    streams: dictionary(state.streams),
    activities: dictionary(state.activities),
    queues: dictionary(state.queues),
    statuses: dictionary(state.statuses),
    approvals: dictionary(state.approvals),
    approvalQueues: queueDictionary(state.approvalQueues),
  };
}

export function reduce(state, event = {}) {
  const current = createState(state);
  const threadId = event.threadId;

  switch (event.type) {
    case 'threads-loaded':
      return { ...current, threads: (event.threads || event.data || []).map((thread) => ({ ...thread })) };
    case 'thread-selected':
      return { ...current, activeThreadId: threadId || null };
    case 'thread-created': {
      const thread = { ...(event.thread || {}), id: threadId || event.thread?.id };
      const threads = thread.id && !current.threads.some((item) => item.id === thread.id)
        ? [thread, ...current.threads]
        : current.threads;
      return { ...current, threads, activeThreadId: thread.id || current.activeThreadId };
    }
    case 'thread-detail': {
      if (!threadId) return current;
      const detail = { ...(event.detail || {}), id: threadId };
      return {
        ...current,
        details: { ...current.details, [threadId]: detail },
        queues: Array.isArray(detail.queue) ? { ...current.queues, [threadId]: detail.queue.map((item) => ({ ...item })) } : current.queues,
        statuses: detail.status ? { ...current.statuses, [threadId]: { ...detail.status } } : current.statuses,
      };
    }
    case 'thread-renamed': {
      const name = event.name || event.title || '';
      return {
        ...current,
        threads: current.threads.map((thread) => thread.id === threadId ? { ...thread, name, title: name } : thread),
        details: current.details[threadId]
          ? { ...current.details, [threadId]: { ...current.details[threadId], name, title: name } }
          : current.details,
      };
    }
    case 'thread-deleted':
      return {
        ...current,
        threads: current.threads.filter((thread) => thread.id !== threadId),
        activeThreadId: current.activeThreadId === threadId ? null : current.activeThreadId,
        details: withoutKey(current.details, threadId),
        drafts: withoutKey(current.drafts, threadId),
        streams: withoutKey(current.streams, threadId),
        activities: withoutKey(current.activities, threadId),
        queues: withoutKey(current.queues, threadId),
        statuses: withoutKey(current.statuses, threadId),
        approvals: withoutKey(current.approvals, threadId),
        approvalQueues: withoutKey(current.approvalQueues, threadId),
      };
    case 'draft-changed':
      return threadId ? { ...current, drafts: { ...current.drafts, [threadId]: String(event.value ?? '').slice(0, MAX_DRAFT_LENGTH) } } : current;
    case 'queue':
      return threadId ? { ...current, queues: { ...current.queues, [threadId]: (event.items || event.queue || []).map((item) => ({ ...item })) } } : current;
    case 'turn-started':
      return threadId ? { ...current, streams: { ...current.streams, [threadId]: '' } } : current;
    case 'assistant-delta':
      return threadId ? { ...current, streams: { ...current.streams, [threadId]: `${current.streams[threadId] || ''}${event.text || ''}` } } : current;
    case 'assistant-message': {
      if (!threadId) return current;
      const detail = current.details[threadId];
      const existingMessages = detail?.messages || [];
      const lastMessage = existingMessages.at(-1);
      const alreadyAuthoritative = lastMessage?.role === 'assistant' && lastMessage.text === (event.text || '');
      const messages = detail && !alreadyAuthoritative
        ? [...existingMessages, { role: 'assistant', text: event.text || '' }]
        : existingMessages;
      return {
        ...current,
        details: detail ? { ...current.details, [threadId]: { ...detail, messages } } : current.details,
        streams: { ...current.streams, [threadId]: '' },
      };
    }
    case 'message-submitted': {
      if (!threadId) return current;
      const detail = current.details[threadId] || { id: threadId, messages: [] };
      return {
        ...current,
        details: {
          ...current.details,
          [threadId]: { ...detail, messages: [...(detail.messages || []), { role: 'user', text: event.text || '' }] },
        },
      };
    }
    case 'activity':
      return threadId ? { ...current, activities: { ...current.activities, [threadId]: upsertActivity(current.activities[threadId], event.activity || event) } } : current;
    case 'activity-cleared':
      return threadId ? { ...current, activities: { ...current.activities, [threadId]: [] } } : current;
    case 'status':
      return threadId ? { ...current, statuses: { ...current.statuses, [threadId]: { state: event.state, detail: event.detail } } } : current;
    case 'approval': {
      if (!threadId || !event.approval) return current;
      const approval = { ...event.approval };
      const existing = current.approvalQueues[threadId] || [];
      const index = existing.findIndex(({ id }) => String(id) === String(approval.id));
      const queue = index === -1
        ? [...existing, approval]
        : existing.map((item, itemIndex) => itemIndex === index ? { ...item, ...approval } : item);
      return {
        ...current,
        approvals: { ...current.approvals, [threadId]: queue[0] },
        approvalQueues: { ...current.approvalQueues, [threadId]: queue },
      };
    }
    case 'approval-resolved': {
      if (!threadId) return current;
      const existing = current.approvalQueues[threadId]
        || (current.approvals[threadId] ? [current.approvals[threadId]] : []);
      const queue = existing.filter(({ id }) => String(id) !== String(event.id));
      if (queue.length === 0) {
        return {
          ...current,
          approvals: withoutKey(current.approvals, threadId),
          approvalQueues: withoutKey(current.approvalQueues, threadId),
        };
      }
      return {
        ...current,
        approvals: { ...current.approvals, [threadId]: queue[0] },
        approvalQueues: { ...current.approvalQueues, [threadId]: queue },
      };
    }
    case 'error':
      return threadId ? { ...current, statuses: { ...current.statuses, [threadId]: { state: 'error', detail: event.message } } } : current;
    default:
      return current;
  }
}

export function getDraft(threadId) {
  if (!threadId) return '';
  return safeDrafts()[threadId] || '';
}

export function setDraft(threadId, value) {
  if (!threadId) return false;
  const drafts = safeDrafts();
  drafts[threadId] = String(value ?? '').slice(0, MAX_DRAFT_LENGTH);
  return writeDrafts(drafts);
}

export function clearThreadState(threadId) {
  if (!threadId) return false;
  const drafts = safeDrafts();
  delete drafts[threadId];
  return writeDrafts(drafts);
}
