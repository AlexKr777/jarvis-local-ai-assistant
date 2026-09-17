import path from 'node:path';

const JARVIS_THREAD_SOURCE = 'jarvis-local';
const TITLE_LIMIT = 48;

function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function timestampFields(source) {
  const fields = {};
  for (const key of ['createdAt', 'updatedAt', 'created_at', 'updated_at', 'recency_at']) {
    if (typeof source?.[key] === 'string') fields[key] = source[key];
  }
  return fields;
}

function safeBasename(filePath) {
  if (typeof filePath !== 'string') return '';
  return path.basename(filePath.replaceAll('\\', path.sep));
}

function publicThreadBase(thread) {
  const name = normalizedText(thread?.name);
  const preview = normalizedText(thread?.preview);
  const title = compactThreadTitle(name || preview);
  return {
    id: thread?.id,
    title,
    preview,
    status: thread?.status,
    ...timestampFields(thread),
  };
}

function userMessageFromItem(item, turn) {
  if (!Array.isArray(item?.content)) return null;

  const text = item.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
  const attachments = item.content
    .filter((part) => part?.type === 'localImage')
    .map((part) => safeBasename(part.path))
    .filter(Boolean)
    .map((name) => ({ type: 'localImage', name }));

  if (!text && attachments.length === 0) return null;
  const message = {
    id: item.id,
    turnId: turn?.id,
    role: 'user',
    text,
  };
  if (attachments.length > 0) message.attachments = attachments;
  return message;
}

function assistantMessageFromItem(item, turn) {
  const text = normalizedText(item?.text);
  if (!text) return null;
  return {
    id: item.id,
    turnId: turn?.id,
    role: 'assistant',
    text,
  };
}

export function isJarvisThread(thread, projectRoot, platform = process.platform) {
  if (thread?.threadSource !== JARVIS_THREAD_SOURCE || typeof thread.cwd !== 'string') return false;
  const actual = path.resolve(thread.cwd);
  const expected = path.resolve(projectRoot);
  return platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

export function compactThreadTitle(text) {
  const normalized = normalizedText(text).replace(/\s+/g, ' ');
  if (!normalized) return '';

  const words = normalized.split(' ');
  const compact = words.length > 1 ? words.slice(0, 6).join(' ') : normalized;
  if (compact.length <= TITLE_LIMIT) return compact;
  return `${compact.slice(0, TITLE_LIMIT - 1)}…`;
}

export function threadSummary(thread) {
  if (thread?.threadSource !== JARVIS_THREAD_SOURCE) return null;
  const name = normalizedText(thread.name);
  const preview = normalizedText(thread.preview);
  if (!name && !preview) return null;
  return publicThreadBase(thread);
}

export function threadDetail(thread) {
  if (thread?.threadSource !== JARVIS_THREAD_SOURCE) return null;

  const messages = [];
  for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
    let finalAssistant = null;
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type === 'userMessage') {
        const message = userMessageFromItem(item, turn);
        if (message) messages.push(message);
      }
      if (item?.type === 'agentMessage') {
        finalAssistant = assistantMessageFromItem(item, turn) || finalAssistant;
      }
    }
    if (finalAssistant) messages.push(finalAssistant);
  }

  return {
    ...publicThreadBase(thread),
    messages,
  };
}
