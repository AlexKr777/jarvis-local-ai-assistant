const DISPLAY_LIMIT = 320;
const DISPLAY_LINE_LIMIT = 6;

const SECRET_VALUE = /\b(token|password|api[_-]?key|secret|authorization)\s*[:=]\s*\S+/gi;
const BEARER_VALUE = /\bbearer\s+\S+/gi;
const ACTION_RESULT = /^(?:готово|сделано|выполнено|открыт(?:а|о|ы)?|запущен(?:а|о|ы)?|создан(?:а|о|ы)?|удал[её]н(?:а|о|ы)?|переименован(?:а|о|ы)?|перемещ[её]н(?:а|о|ы)?|сохран[её]н(?:а|о|ы)?|закрыт(?:а|о|ы)?|done|opened|launched|created|deleted|renamed|moved|saved|closed)(?=$|[\s:,.!?•—-])/i;
const ACTION_REQUEST = /^(?:пожалуйста[, ]+)?(?:открой|запусти|создай|удали|переименуй|перемести|сохрани|закрой|включи|выключи|open|launch|create|delete|rename|move|save|close|start|stop)(?=$|[\s:,.!?•—-])/i;

function cleanAnswer(value) {
  return String(value || '')
    .replace(/```[a-z0-9_-]*\s*/gi, '')
    .replace(/```/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\[([^\]]+)]\((?:https?:\/\/)?[^)]+\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(SECRET_VALUE, '$1=[скрыто]')
    .replace(BEARER_VALUE, 'Bearer [скрыто]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateAtBoundary(text, limit) {
  if (text.length <= limit) return text;
  const candidate = text.slice(0, limit - 1).trimEnd();
  const sentence = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf('! '), candidate.lastIndexOf('? '));
  if (sentence >= Math.floor(limit * 0.55)) return `${candidate.slice(0, sentence + 1).trimEnd()}…`;
  const word = candidate.lastIndexOf(' ');
  return `${candidate.slice(0, word >= Math.floor(limit * 0.55) ? word : candidate.length).trimEnd()}…`;
}

export function compactVoiceAnswer(answer) {
  const cleaned = cleanAnswer(answer);
  const sourceLines = cleaned.split('\n').filter(Boolean);
  const selectedLines = sourceLines.slice(0, DISPLAY_LINE_LIMIT);
  const selected = selectedLines.join('\n');
  const text = truncateAtBoundary(selected, DISPLAY_LIMIT);
  return {
    text,
    truncated: sourceLines.length > DISPLAY_LINE_LIMIT || selected.length > DISPLAY_LIMIT,
  };
}

function statusDisplay(requestId, type, text) {
  return { requestId, type, text, truncated: false };
}

export function buildVoiceDisplay({ requestId, state = 'success', answer = '', transcript = '', activities = [] } = {}) {
  if (state === 'queued') return statusDisplay(requestId, 'queued', 'В очереди');
  if (state === 'executing') return statusDisplay(requestId, 'working', 'Выполняю');
  if (state === 'approval') return statusDisplay(requestId, 'approval', 'Требуется подтверждение');
  if (state === 'confirming') return statusDisplay(requestId, 'working', 'Подтверждение отправлено');
  if (state === 'blocked') return statusDisplay(requestId, 'blocked', 'Опасная системная операция заблокирована');
  if (state === 'auth-required') return statusDisplay(requestId, 'auth-required', 'Требуется вход в Codex');
  if (state === 'error') return statusDisplay(requestId, 'error', 'Не удалось обработать запрос');

  const completed = activities.filter((activity) => activity?.state === 'complete');
  const categories = new Set(completed.map((activity) => activity.category));
  const compact = compactVoiceAnswer(answer);
  const realAction = categories.has('file')
    || (categories.has('command')
      && !categories.has('web')
      && (!compact.text || ACTION_RESULT.test(compact.text) || ACTION_REQUEST.test(String(transcript).trim())));

  if (realAction) {
    const fallback = completed.findLast((activity) => activity?.detail)?.detail || 'Действие выполнено';
    const result = compact.text ? compact : compactVoiceAnswer(fallback);
    return { requestId, type: 'action-success', ...result };
  }
  if (!compact.text) return statusDisplay(requestId, 'error', 'Ответ не получен');
  return { requestId, type: 'answer', ...compact };
}
