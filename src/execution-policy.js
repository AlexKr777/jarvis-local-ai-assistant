import path from 'node:path';

export const EXECUTION_POLICY = Object.freeze({
  AUTO_ALLOW: 'AUTO_ALLOW',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  HARD_BLOCK: 'HARD_BLOCK',
});

const DISK_DESTRUCTION = [
  /\bformat(?:\.com)?\b(?:\s+[^\r\n]*)?\b[a-z]:/i,
  /\bdiskpart\b[\s\S]*\b(?:clean|delete\s+partition|create\s+partition|convert\s+(?:gpt|mbr))\b/i,
  /\b(?:clear-disk|initialize-disk|remove-partition|set-partition)\b/i,
  /\b(?:bcdedit|bootrec|bcdboot)\b/i,
  /(?:отформатир(?:уй|овать)|форматир(?:уй|овать))[^\r\n]{0,80}(?:диск|том|раздел|[a-z]:)/i,
  /(?:очисти|очистить|удали|удалить)[^\r\n]{0,50}(?:диск|раздел диска|загрузочн)/i,
];

const DELETE_ACTION = /(?:\bremove-item\b|\bclear-content\b|\bdel(?:ete)?\b|\berase\b|\brmdir\b|\brd\b|\brm\b|\bunlink\b|\brecycle\b|удал(?:и|ить|яй)|перемест(?:и|ить)[^\r\n]{0,30}корзин)/i;
const CORE_ROOT = /(?:\b[a-z]:\\(?:windows(?:\\system32)?|program files(?: \(x86\))?|programdata)(?:\\|\b)|\$env:(?:windir|systemroot)|%(?:windir|systemroot)%|\\windows\\system32\b)/i;
const OVERWRITE_ACTION = /(?:\bset-content\b|\bout-file\b|\b(?:copy-item|move-item|rename-item|cp|mv)\b[^\r\n]*\s-force\b|(?:^|[^>])>>?\s*[^&])/i;
const SYSTEM_CHANGE = /(?:\breg(?:\.exe)?\s+(?:add|delete|import|restore)\b|\b(?:set-itemproperty|new-itemproperty|remove-itemproperty)\b[^\r\n]*\b(?:registry::|hkcu:|hklm:)|\b(?:sc(?:\.exe)?\s+(?:config|delete|stop)|stop-service|set-service)\b|\b(?:shutdown|restart-computer|stop-computer)\b|\b(?:schtasks|register-scheduledtask|unregister-scheduledtask)\b|\b(?:set-executionpolicy|takeown|icacls|chmod|chown|runas)\b|\bstart-process\b[^\r\n]*\s-verb\s+runas\b|\b(?:netsh|set-netfirewallprofile|disable-windowsoptionalfeature)\b)/i;
const INSTALL_ACTION = /(?:\b(?:winget|choco|scoop)\s+(?:install|uninstall|upgrade)\b|\bmsiexec\b|\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:install|add|remove|uninstall|update)\b|\bpip(?:3)?\s+(?:install|uninstall)\b)/i;
const PROCESS_TERMINATION = /(?:\b(?:taskkill|stop-process|kill|pkill)\b)/i;
const EXTERNAL_MUTATION = /(?:\bcurl(?:\.exe)?\b[^\r\n]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b|--data(?:-raw|-binary|-urlencode)?\b)|\binvoke-restmethod\b[^\r\n]*\s-method\s+(?:post|put|patch|delete)\b)/i;

const SAFE_COMMAND = [
  /(?:^|[;&|]\s*|(?:^|\s)-(?:command|c)\s+["']?)(?:get-childitem|get-item|get-content|get-location|get-date|get-process|get-service|get-ciminstance|test-path|resolve-path|measure-object|select-string)\b/i,
  /(?:^|[;&|]\s*)(?:dir|ls|type|where(?:\.exe)?|findstr|rg|systeminfo|ipconfig|whoami|hostname)\b/i,
  /(?:^|[;&|]\s*)git(?:\.exe)?\s+(?:status|diff|log|show|rev-parse|ls-files)\b/i,
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:test|run\s+(?:test|check|lint|build))\b/i,
  /(?:^|[;&|]\s*)node(?:\.exe)?\s+(?:--check|--test)\b/i,
  /(?:^|[;&|]\s*|(?:^|\s)-(?:command|c)\s+["']?)(?:new-item|mkdir|md|copy-item|copy|move-item|move|rename-item|ren)\b/i,
  /(?:^|[;&|]\s*|(?:^|\s)-(?:command|c)\s+["']?)(?:start-process|explorer(?:\.exe)?|start)\b/i,
  /(?:^|[;&|]\s*|(?:^|\s)-(?:command|c)\s+["']?)(?:invoke-webrequest|curl(?:\.exe)?)\b/i,
  /(?:^|[;&|]\s*|(?:^|\s)-(?:command|c)\s+["']?)(?:write-output|echo)\b(?![^\r\n]*>)/i,
];

function commandText(command) {
  if (Array.isArray(command)) return command.filter((item) => typeof item === 'string').join(' ');
  return typeof command === 'string' ? command : '';
}

function unquote(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.at(-1) === '"') || (trimmed[0] === "'" && trimmed.at(-1) === "'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeWindowsTarget(value, cwd) {
  const target = unquote(value).replace(/[;,]+$/, '');
  if (!target || target.startsWith('-') || /[%$*?]/.test(target)) return null;
  const base = typeof cwd === 'string' && path.win32.isAbsolute(cwd) ? cwd : 'C:\\';
  const resolved = path.win32.isAbsolute(target) ? path.win32.normalize(target) : path.win32.resolve(base, target);
  return resolved.replace(/[\\/]+$/, '') || path.win32.parse(resolved).root;
}

function extractTargets(text, cwd) {
  const candidates = [];
  const pathFlag = /(?:-literalpath|-path)\s+("[^"]+"|'[^']+'|[^\s;|]+)/gi;
  for (const match of text.matchAll(pathFlag)) candidates.push(match[1]);
  if (candidates.length === 0) {
    const action = /(?:remove-item|clear-content|del(?:ete)?|erase|rmdir|rd|rm|copy-item|move-item|rename-item)\s+(?:-[a-z]+\s+)*("[^"]+"|'[^']+'|[^\s;|]+)/gi;
    for (const match of text.matchAll(action)) candidates.push(match[1]);
  }
  const targets = [];
  for (const candidate of candidates) {
    const normalized = normalizeWindowsTarget(candidate, cwd);
    if (normalized && !targets.includes(normalized)) targets.push(normalized);
  }
  return targets.slice(0, 8);
}

function decision(policy, reason, targets = []) {
  return {
    policy,
    reason,
    targets,
    target: targets[0] || null,
    overrideAllowed: policy !== EXECUTION_POLICY.HARD_BLOCK,
  };
}

function hasOnlyReadActions(actions) {
  return Array.isArray(actions)
    && actions.length > 0
    && actions.every((action) => ['read', 'listFiles', 'search'].includes(action?.type));
}

export function classifyExecutionRequest(request = {}) {
  const text = [commandText(request.command), typeof request.target === 'string' ? request.target : '']
    .filter(Boolean)
    .join(' ');
  const targets = extractTargets(text, request.cwd);

  if ((DELETE_ACTION.test(text) && CORE_ROOT.test(text)) || DISK_DESTRUCTION.some((pattern) => pattern.test(text))) {
    return decision(EXECUTION_POLICY.HARD_BLOCK, 'critical-system-destruction', targets);
  }
  if (
    DELETE_ACTION.test(text)
    || OVERWRITE_ACTION.test(text)
    || SYSTEM_CHANGE.test(text)
    || INSTALL_ACTION.test(text)
    || PROCESS_TERMINATION.test(text)
    || EXTERNAL_MUTATION.test(text)
  ) return decision(EXECUTION_POLICY.CONFIRM_REQUIRED, 'destructive-or-system-change', targets);

  if (request.explicitUserRequest !== true) {
    return decision(EXECUTION_POLICY.CONFIRM_REQUIRED, 'not-an-explicit-user-action', targets);
  }
  if (String(request.method || '').includes('fileChange') || String(request.method || '').includes('permissions')) {
    return decision(EXECUTION_POLICY.CONFIRM_REQUIRED, 'write-or-permission-scope', targets);
  }
  if (request.networkApprovalContext) return decision(EXECUTION_POLICY.AUTO_ALLOW, 'read-only-network-access', targets);
  if (hasOnlyReadActions(request.commandActions)) return decision(EXECUTION_POLICY.AUTO_ALLOW, 'structured-read-only-action', targets);
  if (SAFE_COMMAND.some((pattern) => pattern.test(text))) return decision(EXECUTION_POLICY.AUTO_ALLOW, 'recognized-safe-command', targets);
  return decision(EXECUTION_POLICY.CONFIRM_REQUIRED, 'unclassified-command', targets);
}

export function classifyConcreteAction({ command, cwd, target, method, commandActions, networkApprovalContext } = {}) {
  const classified = classifyExecutionRequest({
    command,
    cwd,
    target,
    method: method || 'item/commandExecution/requestApproval',
    commandActions,
    networkApprovalContext,
    explicitUserRequest: true,
  });
  const level = classified.policy === EXECUTION_POLICY.HARD_BLOCK
    ? 'hard-block'
    : classified.policy === EXECUTION_POLICY.CONFIRM_REQUIRED
      ? 'approval'
      : 'auto';
  return { ...classified, level };
}

export function classifyVoiceIntent(transcript, { cwd } = {}) {
  const text = typeof transcript === 'string' ? transcript.trim() : '';
  if (!text) return { ...decision(EXECUTION_POLICY.AUTO_ALLOW, 'empty'), level: 'auto' };
  const classified = classifyConcreteAction({ command: text, cwd });
  if (classified.policy !== EXECUTION_POLICY.CONFIRM_REQUIRED || classified.reason !== 'unclassified-command') {
    return classified;
  }
  return { ...decision(EXECUTION_POLICY.AUTO_ALLOW, 'natural-language-intent', classified.targets), level: 'auto' };
}
