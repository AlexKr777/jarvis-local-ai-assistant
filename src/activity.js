import path from 'node:path';

const TITLE_LIMIT = 64;
const DETAIL_LIMIT = 180;
const PATH_LIMIT = 5;

const TITLES = {
  web: 'Поиск в интернете',
  commandStarted: 'Выполняю действие',
  commandComplete: 'Действие выполнено',
  commandFailed: 'Действие не выполнено',
  fileStarted: 'Файлы изменяются',
  fileComplete: 'Файлы изменены',
  approval: 'Нужно подтверждение',
  queue: 'Сообщение в очереди',
  transcription: 'Распознавание голоса',
};

function flatten(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(value, limit) {
  const text = flatten(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).trimEnd()}...`;
}

function publicText(value, limit = DETAIL_LIMIT) {
  return cap(value, limit)
    .replace(/((?:authorization|x-api-key|api-key):\s*)(bearer\s+)?[^"'\s]+/gi, '$1[redacted]')
    .replace(/\s--(?:token|api-key|password|secret)(?:=|\s+)\S+/gi, ' --redacted [redacted]')
    .replace(/\b(?:token|password|api[_-]?key|secret)\s+\S+/gi, '[redacted] [redacted]')
    .replace(/\b(bearer)\s+\S+/gi, '$1 [redacted]')
    .replace(/\b(token|password|api[_-]?key|secret)[:=]\S+/gi, '$1=[redacted]');
}

function hasStableId(item) {
  return typeof item?.id === 'string' && item.id.trim() !== '';
}

function phaseState(phase, item = {}) {
  if (phase === 'started') return 'working';
  const status = flatten(item.status).toLowerCase();
  if (status === 'failed' || status === 'error' || (Number.isInteger(item.exitCode) && item.exitCode !== 0)) {
    return 'error';
  }
  return 'complete';
}

function event(id, category, title, detail, state) {
  return {
    id,
    category,
    title: cap(title, TITLE_LIMIT),
    detail: cap(detail, DETAIL_LIMIT),
    state,
  };
}

function resultCount(item) {
  if (Array.isArray(item.results)) return item.results.length;
  if (Number.isInteger(item.resultCount)) return item.resultCount;
  if (Number.isInteger(item.resultsCount)) return item.resultsCount;
  if (Number.isInteger(item.count)) return item.count;
  return null;
}

function resultLabel(count) {
  if (count === 1) return '1 результат';
  return `${count} результатов`;
}

function commandText(command) {
  if (Array.isArray(command)) return command.map((part) => flatten(part)).filter(Boolean).join(' ');
  return flatten(command);
}

function basePath(value) {
  const text = flatten(value);
  if (!text) return '';
  return path.basename(text.replaceAll('\\', path.sep)) || text;
}

function commandActionsDetail(commandActions) {
  if (!Array.isArray(commandActions)) return '';
  const actions = commandActions
    .map((action) => {
      const type = flatten(action?.type || action?.action || action?.kind?.type || action?.kind);
      const target = publicText(action?.path || action?.target || action?.file || action?.cwd, 120);
      if (/^(?:unknown|unspecified|other)$/i.test(type)) return target;
      return type && target ? `${type} ${target}` : type || target;
    })
    .filter(Boolean);

  if (actions.length === 0) return '';
  const capped = actions.slice(0, PATH_LIMIT);
  const extra = actions.length - capped.length;
  return extra > 0 ? `${capped.join('; ')}; +${extra} more` : capped.join('; ');
}

function commandDetail(item) {
  const actions = commandActionsDetail(item.commandActions);
  if (actions) return actions;
  const command = commandText(item.command).toLowerCase();
  if (/\b(?:get-childitem|dir|ls)\b/.test(command)) return 'Просматриваю файлы';
  if (/\b(?:start-process|start|open)\b/.test(command)) return 'Открываю приложение';
  if (/\b(?:new-item|mkdir|md)\b/.test(command)) return 'Создаю объект';
  if (/\b(?:remove-item|delete|del|rm)\b/.test(command)) return 'Работаю с выбранным объектом';
  return 'Локальное действие';
}

function changeAction(change) {
  const raw = flatten(change?.action || change?.type || change?.kind?.type || change?.kind).toLowerCase();
  if (/^(create|created|add|added|new)$/.test(raw)) return 'создан';
  if (/^(delete|deleted|remove|removed)$/.test(raw)) return 'удален';
  if (/^(update|updated|modify|modified|edit|edited)$/.test(raw)) return 'обновлен';
  return raw || 'изменен';
}

function changePath(change) {
  return publicText(change?.path || change?.file || change?.target || change?.to || change?.from, 120);
}

function fileDetail(item) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const visible = changes
    .map((change) => {
      const filePath = changePath(change);
      return filePath ? `${changeAction(change)} ${filePath}` : '';
    })
    .filter(Boolean);

  if (visible.length === 0) return 'changes';
  const capped = visible.slice(0, PATH_LIMIT);
  const extra = visible.length - capped.length;
  return extra > 0 ? `${capped.join('; ')}; +${extra} more` : capped.join('; ');
}

function webActivity(item, phase) {
  const count = resultCount(item);
  const detail = phase === 'completed' && count !== null ? resultLabel(count) : publicText(item.query || item.title || 'web search');
  return event(item.id, 'web', TITLES.web, detail, phaseState(phase, item));
}

function commandActivity(item, phase) {
  const state = phaseState(phase, item);
  const title = phase === 'started'
    ? TITLES.commandStarted
    : state === 'error'
      ? TITLES.commandFailed
      : TITLES.commandComplete;
  return event(item.id, 'command', title, commandDetail(item), state);
}

function fileActivity(item, phase) {
  const title = phase === 'started' ? TITLES.fileStarted : TITLES.fileComplete;
  return event(item.id, 'file', title, fileDetail(item), phaseState(phase, item));
}

function systemActivity(item, phase, category, title) {
  const detail = publicText(item.detail || item.message || item.text || item.status || title);
  return event(item.id, category, title, detail, phaseState(phase, item));
}

function approvalDetail(approval = {}) {
  const kind = flatten(approval.kind).toLowerCase();
  const command = commandText(approval.command);
  const target = publicText(approval.target || approval.host || approval.path || approval.grantRoot, 96);

  if (kind === 'network') {
    return target ? `Сетевой доступ к ${target} ожидает разрешения` : 'Сетевой доступ ожидает разрешения';
  }
  if (kind === 'file-change') {
    return target ? `Изменение ${basePath(target)} ожидает разрешения` : 'Изменение файлов ожидает разрешения';
  }
  if (/\b(?:remove-item|delete|del|erase|rmdir|rd|rm)\b/i.test(command)) {
    return target ? `Удаление ${basePath(target)} ожидает разрешения` : 'Удаление ожидает разрешения';
  }
  if (/\b(?:start-process|start|open)\b/i.test(command)) return 'Запуск приложения ожидает разрешения';
  return 'Действие ожидает разрешения';
}

export function activityFromItem(item, phase) {
  if (!item || item.type === 'reasoning') return null;
  if (!hasStableId(item)) return null;

  switch (item.type) {
    case 'webSearch':
      return webActivity(item, phase);
    case 'commandExecution':
      return commandActivity(item, phase);
    case 'fileChange':
      return fileActivity(item, phase);
    case 'queue':
      return systemActivity(item, phase, 'queue', TITLES.queue);
    case 'transcription':
      return systemActivity(item, phase, 'transcription', TITLES.transcription);
    default:
      return null;
  }
}

export function approvalActivity(approval, phase) {
  const id = hasStableId(approval) ? approval.id : 'approval';
  const detail = approvalDetail(approval);
  const title = phase === 'completed'
    ? 'Действие подтверждено'
    : phase === 'declined'
      ? 'Действие отклонено'
      : phase === 'cancelled'
        ? 'Подтверждение отменено'
        : phase === 'answered'
          ? 'Ответ отправлен'
          : TITLES.approval;
  const state = ['completed', 'declined', 'cancelled'].includes(phase)
    ? 'complete'
    : phase === 'answered'
      ? 'working'
      : 'waiting';
  return event(id, 'approval', title, detail, state);
}
