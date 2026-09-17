function encoded(value) {
  return encodeURIComponent(String(value));
}

function jsonOptions(method, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return options;
}

export function createApi({
  fetchImpl = (...args) => globalThis.fetch(...args),
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  async function request(path, options) {
    const response = await fetchImpl(path, options);
    let payload = null;
    try {
      const text = await response.text();
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const publicError = payload?.error;
      const error = new Error(publicError?.message || 'JARVIS не смог выполнить запрос.');
      error.code = publicError?.code || 'REQUEST_FAILED';
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const client = {
    listThreads(searchTerm = '') {
      const query = new URLSearchParams();
      if (String(searchTerm).trim()) query.set('search', String(searchTerm).trim());
      const suffix = query.size ? `?${query}` : '';
      return request(`/api/threads${suffix}`);
    },
    createThread() {
      return request('/api/threads', jsonOptions('POST'));
    },
    readThread(threadId) {
      return request(`/api/threads/${encoded(threadId)}`);
    },
    resumeThread(threadId) {
      return request(`/api/threads/${encoded(threadId)}/resume`, jsonOptions('POST'));
    },
    renameThread(threadId, name) {
      return request(`/api/threads/${encoded(threadId)}`, jsonOptions('PATCH', { name }));
    },
    deleteThread(threadId) {
      return request(`/api/threads/${encoded(threadId)}`, jsonOptions('DELETE'));
    },
    deleteAllThreads() {
      return request('/api/threads', jsonOptions('DELETE'));
    },
    send(threadId, message, attachmentIds = []) {
      return request('/api/chat', jsonOptions('POST', { threadId, message, attachmentIds }));
    },
    removeQueued(threadId, queueId) {
      return request(`/api/threads/${encoded(threadId)}/queue/${encoded(queueId)}`, jsonOptions('DELETE'));
    },
    uploadAttachment(attachment) {
      return request('/api/attachments', jsonOptions('POST', attachment));
    },
    deleteAttachment(threadId, attachmentId) {
      const query = new URLSearchParams({ threadId: String(threadId) });
      return request(`/api/attachments/${encoded(attachmentId)}?${query}`, jsonOptions('DELETE'));
    },
    transcribe(audio) {
      return request('/api/transcriptions', jsonOptions('POST', audio));
    },
    respondApproval(id, decision) {
      return request('/api/approvals', jsonOptions('POST', { id, decision }));
    },
    cryptoStatus() {
      return request('/api/crypto/status');
    },
    setCryptoMode(mode) {
      return request('/api/crypto/mode', jsonOptions('POST', { mode }));
    },
    runCryptoDryRun() {
      return request('/api/crypto/dry-run', jsonOptions('POST'));
    },
    resetCryptoPostLimit() {
      return request('/api/crypto/reset-post-limit', jsonOptions('POST'));
    },
    confirmCryptoAuto(force = false) {
      return request('/api/crypto/confirm-auto', jsonOptions('POST', force ? { force: true } : {}));
    },
    parserStatus() {
      return request('/api/parser/status');
    },
    parserStart() {
      return request('/api/parser/start', jsonOptions('POST', {}));
    },
    parserStop() {
      return request('/api/parser/stop', jsonOptions('POST', {}));
    },
    parserSettings() {
      return request('/api/parser/settings');
    },
    saveParserSettings(body) {
      return request('/api/parser/settings', jsonOptions('PUT', body));
    },
    parserSendCode(apiId, apiHash, phone) {
      return request('/api/parser/telegram/send-code', jsonOptions('POST', { apiId, apiHash, phone }));
    },
    parserVerify(code, password = '') {
      return request('/api/parser/telegram/verify', jsonOptions('POST', { code, password }));
    },
    parserReconnect() {
      return request('/api/parser/telegram/reconnect', jsonOptions('POST', {}));
    },
    parserDisconnect() {
      return request('/api/parser/telegram/disconnect', jsonOptions('POST', {}));
    },
    parserDiscoveryStart(queries) {
      return request('/api/parser/discovery/start', jsonOptions('POST', { queries }));
    },
    parserDiscoveryStop() {
      return request('/api/parser/discovery/stop', jsonOptions('POST', {}));
    },
    parserDiscoveryResume(runId) {
      return request('/api/parser/discovery/resume', jsonOptions('POST', { runId }));
    },
    parserDiscoveryStatus(runId = '') {
      const query = runId ? `?${new URLSearchParams({ runId })}` : '';
      return request(`/api/parser/discovery/status${query}`);
    },
    parserDiscoveryRuns(filters = {}) {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value !== undefined));
      return request(`/api/parser/discovery/runs${query.size ? `?${query}` : ''}`);
    },
    parserGroups(filters = {}) {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value !== undefined && value !== false));
      return request(`/api/parser/groups${query.size ? `?${query}` : ''}`);
    },
    parserIgnoreGroup(groupId) {
      return request(`/api/parser/groups/${encoded(groupId)}/ignore`, jsonOptions('POST', {}));
    },
    parserLeaveGroup(groupId) {
      return request(`/api/parser/groups/${encoded(groupId)}/leave`, jsonOptions('POST', {}));
    },
    parserQueue() {
      return request('/api/parser/queue');
    },
    parserQueueAdd(groupIds) {
      return request('/api/parser/queue/add', jsonOptions('POST', { groupIds }));
    },
    parserQueuePause() {
      return request('/api/parser/queue/pause', jsonOptions('POST', {}));
    },
    parserQueueResume() {
      return request('/api/parser/queue/resume', jsonOptions('POST', {}));
    },
    parserQueueRemove(itemId) {
      return request(`/api/parser/queue/${encoded(itemId)}`, jsonOptions('DELETE'));
    },
    parserQueueClearCompleted() {
      return request('/api/parser/queue/clear-completed', jsonOptions('POST', {}));
    },
    parserMonitoring() {
      return request('/api/parser/monitoring');
    },
    parserMonitoringSet(groupId, enabled) {
      return request(`/api/parser/monitoring/${encoded(groupId)}/${enabled ? 'start' : 'stop'}`, jsonOptions('POST', {}));
    },
    parserLeads(filters = {}) {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value !== undefined && value !== false));
      return request(`/api/parser/leads${query.size ? `?${query}` : ''}`);
    },
    parserAudit(filters = {}) {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value !== undefined && value !== false));
      return request(`/api/parser/audit${query.size ? `?${query}` : ''}`);
    },
    parserAuditFeedback(revisionId, verdict, correctedCategory = '', reason = '') {
      return request(`/api/parser/audit/${encoded(revisionId)}/feedback`, jsonOptions('POST', { verdict, correctedCategory, reason }));
    },
    parserLeadFeedback(leadId, verdict, reason = '') {
      return request(`/api/parser/leads/${encoded(leadId)}/feedback`, jsonOptions('POST', { verdict, reason }));
    },
    parserIgnoreAuthor(leadId, authorId) {
      return request(`/api/parser/leads/${encoded(leadId)}/ignore-author`, jsonOptions('POST', { authorId }));
    },
    parserIgnoreChat(leadId, telegramGroupId) {
      return request(`/api/parser/leads/${encoded(leadId)}/ignore-chat`, jsonOptions('POST', { telegramGroupId }));
    },
    parserTestAi() {
      return request('/api/parser/ai/test', jsonOptions('POST', {}));
    },
    parserTestNotification() {
      return request('/api/parser/notification/test', jsonOptions('POST', {}));
    },
    connectEvents(onEvent, onReconnect = () => {}) {
      if (typeof EventSourceImpl !== 'function') throw new Error('EventSource недоступен в этом браузере.');
      const source = new EventSourceImpl('/api/events');
      let opened = false;
      let disconnected = false;

      source.onmessage = ({ data }) => {
        try {
          onEvent(JSON.parse(data));
        } catch {
          // A malformed event is ignored; the next authoritative refresh repairs state.
        }
      };
      source.onerror = () => {
        if (opened) disconnected = true;
      };
      source.onopen = () => {
        if (opened && disconnected) {
          disconnected = false;
          Promise.resolve(onReconnect()).catch(() => {});
        }
        opened = true;
      };
      return source;
    },
  };

  return client;
}

export const api = createApi();
