(function jarvisApplication(globalScope) {
  const THREAD_MUTATION_TYPES = new Set([
    'thread-created',
    'thread-renamed',
    'thread-deleted',
    'queue',
    'turn-started',
    'assistant-delta',
    'assistant-message',
    'message-submitted',
    'activity',
    'activity-cleared',
    'status',
    'approval',
    'approval-resolved',
    'error',
    'crypto-activity',
  ]);

  function reconcileChildOrder(parent, desiredNodes) {
    const desired = desiredNodes.filter(Boolean);
    const desiredSet = new Set(desired);
    for (let index = 0; index < desired.length; index += 1) {
      const node = desired[index];
      const current = parent.children[index] || null;
      if (current !== node) parent.insertBefore(node, current);
    }
    for (const child of [...parent.children]) {
      if (!desiredSet.has(child)) parent.removeChild(child);
    }
  }

  function createRenderGate() {
    const regionKeys = new Map();
    return (region, key) => {
      if (regionKeys.has(region) && regionKeys.get(region) === key) return false;
      regionKeys.set(region, key);
      return true;
    };
  }

  function createController({ api, stateTools, onChange = () => {}, confirmDelete = () => true }) {
    let state = stateTools.createState();
    let connection = null;
    const pendingThreads = new Set();
    const detailRequestVersions = new Map();
    const threadEventVersions = new Map();
    let threadListRequestVersion = 0;

    function publish(event) {
      if (event?.threadId && THREAD_MUTATION_TYPES.has(event.type)) {
        threadEventVersions.set(event.threadId, (threadEventVersions.get(event.threadId) || 0) + 1);
      }
      state = stateTools.reduce(state, event);
      onChange(state, event);
      return state;
    }

    async function refreshThreads(searchTerm = '') {
      const requestVersion = ++threadListRequestVersion;
      const result = await api.listThreads(searchTerm);
      if (requestVersion !== threadListRequestVersion) return result;
      publish({ type: 'threads-loaded', threads: result?.data || [] });
      return result;
    }

    async function loadDetail(threadId) {
      const requestVersion = (detailRequestVersions.get(threadId) || 0) + 1;
      const eventVersion = threadEventVersions.get(threadId) || 0;
      detailRequestVersions.set(threadId, requestVersion);
      const detail = await api.readThread(threadId);
      if (detailRequestVersions.get(threadId) !== requestVersion) return detail;
      if ((threadEventVersions.get(threadId) || 0) !== eventVersion) return detail;
      publish({ type: 'thread-detail', threadId, detail });
      return detail;
    }

    async function selectThread(threadId) {
      if (!threadId) return null;
      publish({ type: 'thread-selected', threadId });
      return loadDetail(threadId);
    }

    async function newThread() {
      const thread = await api.createThread();
      const threadId = thread?.id;
      if (!threadId) throw new Error('JARVIS не вернул идентификатор нового диалога.');
      publish({ type: 'thread-created', threadId, thread });
      publish({
        type: 'thread-detail',
        threadId,
        detail: {
          ...thread,
          messages: Array.isArray(thread.messages) ? thread.messages : [],
          queue: Array.isArray(thread.queue) ? thread.queue : [],
        },
      });
      return thread;
    }

    async function reconcile() {
      const result = await refreshThreads('');
      const threadId = state.activeThreadId;
      const materialized = (result?.data || []).some((thread) => thread.id === threadId);
      if (threadId && materialized) await loadDetail(threadId);
    }

    function handleEvent(event) {
      if (!event || typeof event !== 'object') return;
      if (event.threadId && event.type === 'turn-started') pendingThreads.add(event.threadId);
      if (event.threadId && ['assistant-delta', 'assistant-message', 'error'].includes(event.type)) pendingThreads.delete(event.threadId);
      if (event.threadId && event.type === 'status' && ['idle', 'ready', 'error'].includes(event.state)) pendingThreads.delete(event.threadId);
      publish(event);
    }

    async function boot({ excludedThreadIds = [] } = {}) {
      const result = await refreshThreads('');
      const excluded = new Set(Array.isArray(excludedThreadIds) ? excludedThreadIds : []);
      let threadId = state.activeThreadId;
      if (!threadId || excluded.has(threadId) || !(result?.data || []).some((thread) => thread.id === threadId)) {
        threadId = (result?.data || []).find((thread) => !excluded.has(thread.id))?.id || null;
      }
      if (threadId) await selectThread(threadId);
      else await newThread();
      connection = api.connectEvents(handleEvent, reconcile);
      return state;
    }

    function changeDraft(value) {
      const threadId = state.activeThreadId;
      if (!threadId) return false;
      publish({ type: 'draft-changed', threadId, value });
      return stateTools.setDraft(threadId, value);
    }

    async function send(options = []) {
      const threadId = state.activeThreadId;
      const draftAtSend = String(state.drafts[threadId] || '');
      const normalized = Array.isArray(options) ? { attachmentIds: options } : (options || {});
      const attachmentIds = Array.isArray(normalized.attachmentIds) ? normalized.attachmentIds : [];
      const serverMessage = String(normalized.serverMessage ?? draftAtSend).trim();
      const visibleText = String(normalized.visibleText ?? draftAtSend).trim();
      if (!threadId || !serverMessage || !visibleText) return null;
      const result = await api.send(threadId, serverMessage, attachmentIds);
      publish({ type: 'message-submitted', threadId, text: visibleText });
      if (Array.isArray(result?.queue)) publish({ type: 'queue', threadId, items: result.queue });
      if (String(state.drafts[threadId] || '') === draftAtSend) {
        publish({ type: 'draft-changed', threadId, value: '' });
        stateTools.setDraft(threadId, '');
      }
      return result;
    }

    async function renameThread(threadId, name) {
      const normalized = String(name || '').trim().replace(/\s+/g, ' ');
      if (!normalized) return null;
      const result = await api.renameThread(threadId, normalized);
      publish({ type: 'thread-renamed', threadId, name: result?.name || normalized });
      return result;
    }

    async function removeQueued(threadId, queueId) {
      const result = await api.removeQueued(threadId, queueId);
      if (!Array.isArray(result?.queue)) {
        const error = new Error('JARVIS вернул некорректный снимок очереди.');
        error.code = 'INVALID_RESPONSE';
        throw error;
      }
      publish({ type: 'queue', threadId, items: result.queue });
      return result;
    }

    async function deleteThread(threadId) {
      if (!await confirmDelete(threadId)) return false;
      await api.deleteThread(threadId);
      stateTools.clearThreadState(threadId);
      publish({ type: 'thread-deleted', threadId });
      const result = await refreshThreads('');
      const remaining = (result?.data || []).filter((thread) => thread.id !== threadId);
      if (remaining.length > 0) await selectThread(remaining[0].id);
      else await newThread();
      return true;
    }

    async function deleteAllThreads() {
      const result = await api.deleteAllThreads();
      const deletedThreadIds = Array.isArray(result?.deletedThreadIds) ? result.deletedThreadIds : [];
      for (const threadId of deletedThreadIds) {
        pendingThreads.delete(threadId);
        stateTools.clearThreadState(threadId);
        publish({ type: 'thread-deleted', threadId });
      }
      await refreshThreads('');
      const thread = result?.thread;
      if (thread?.id) {
        publish({ type: 'thread-created', threadId: thread.id, thread });
        publish({
          type: 'thread-detail',
          threadId: thread.id,
          detail: {
            ...thread,
            messages: Array.isArray(thread.messages) ? thread.messages : [],
            queue: Array.isArray(thread.queue) ? thread.queue : [],
          },
        });
      }
      return result;
    }

    function clearActivity(threadId = state.activeThreadId) {
      if (!threadId) return false;
      publish({ type: 'activity-cleared', threadId });
      return true;
    }

    async function resolveApproval(threadId, id, decision) {
      if (!threadId) throw new Error('Не удалось определить диалог подтверждения.');
      return api.respondApproval(id, decision);
    }

    return {
      boot,
      changeDraft,
      clearActivity,
      close() { connection?.close(); connection = null; },
      deleteAllThreads,
      deleteThread,
      getState: () => state,
      handleEvent,
      isPending: (threadId) => pendingThreads.has(threadId),
      newThread,
      reconcile,
      reloadThread: loadDetail,
      removeQueued,
      renameThread,
      resolveApproval,
      search: refreshThreads,
      selectThread,
      send,
    };
  }

  globalScope.JarvisApp = Object.freeze({ createController, createRenderGate, reconcileChildOrder });
  if (typeof document === 'undefined') return;

  Promise.all([import('./state.js'), import('./api.js'), import('./chat-view.js'), import('./crypto-ui.js'), import('./parser-ui.js')])
    .then(([stateTools, { api }, chatView, cryptoUi, parserUi]) => startBrowserApp({ stateTools, api, chatView, cryptoUi, parserUi }))
    .catch((error) => {
      const output = document.querySelector('#status .status-text');
      if (output) output.textContent = error?.message || 'Не удалось запустить JARVIS.';
    });

  function startBrowserApp({ stateTools, api, chatView, cryptoUi, parserUi }) {
    const el = {
      appShell: document.querySelector('.app-shell'),
      chatContent: document.querySelector('.chat-content'),
      chatScroll: document.querySelector('#chat-scroll'),
      welcome: document.querySelector('#welcome'),
      form: document.querySelector('#chat-form'),
      field: document.querySelector('#message'),
      status: document.querySelector('#status'),
      statusText: document.querySelector('#status .status-text'),
      newChat: document.querySelector('#new-chat'),
      conversationTitle: document.querySelector('#conversation-title'),
      sidebar: document.querySelector('#sidebar'),
      historySearch: document.querySelector('#history-search'),
      historyList: document.querySelector('#history-list'),
      historyOpen: document.querySelector('#history-open'),
      historyClose: document.querySelector('#history-close'),
      historyBackdrop: document.querySelector('#history-backdrop'),
      activityPanel: document.querySelector('#activity-panel'),
      activitySteps: document.querySelector('#activity-steps'),
      activityToggle: document.querySelector('#activity-toggle'),
      activityClose: document.querySelector('#activity-close'),
      activityOpen: document.querySelector('#activity-open'),
      activityClear: document.querySelector('#activity-clear'),
      deleteAllThreads: document.querySelector('#delete-all-threads'),
      deleteAllDialog: document.querySelector('#delete-all-dialog'),
      deleteAllCount: document.querySelector('#delete-all-count'),
      deleteAllCancel: document.querySelector('#delete-all-cancel'),
      deleteAllConfirm: document.querySelector('#delete-all-confirm'),
      dialog: document.querySelector('#approval-dialog'),
      approvalReason: document.querySelector('#approval-reason'),
      approvalCommand: document.querySelector('#approval-command'),
      approvalAllow: document.querySelector('#approval-allow'),
      toast: document.querySelector('#toast'),
      attachmentInput: document.querySelector('#attachment-input'),
      attachButton: document.querySelector('#attach-button'),
      attachmentPreview: document.querySelector('#attachment-preview'),
      queueTray: document.querySelector('#queue-tray'),
      dragOverlay: document.querySelector('#drag-overlay'),
      micButton: document.querySelector('#mic-button'),
      recordingTimer: document.querySelector('#recording-timer'),
      mediaStatus: document.querySelector('#media-status'),
      send: document.querySelector('#send'),
      sendIcon: document.querySelector('#send-icon'),
      checkIcon: document.querySelector('#check-icon'),
      cryptoOpen: document.querySelector('#crypto-open'),
      cryptoStatusText: document.querySelector('#crypto-status'),
      cryptoContext: document.querySelector('#crypto-context'),
      cryptoContextStatus: document.querySelector('#crypto-context-status'),
      cryptoMode: document.querySelector('#crypto-mode'),
      cryptoEnableAuto: document.querySelector('#crypto-enable-auto'),
      cryptoDryRun: document.querySelector('#crypto-dry-run'),
      cryptoResetPostLimit: document.querySelector('#crypto-reset-post-limit'),
      cryptoScanner: document.querySelector('#crypto-scanner'),
      cryptoModeLabel: document.querySelector('#crypto-mode-label'),
      cryptoPosts: document.querySelector('#crypto-posts'),
      cryptoSlots: document.querySelector('#crypto-slots'),
      cryptoCredential: document.querySelector('#crypto-credential'),
      cryptoCodex: document.querySelector('#crypto-ai'),
      cryptoOllama: document.querySelector('#crypto-ollama'),
      cryptoEventStream: document.querySelector('#crypto-event-stream'),
      cryptoSideEventStream: document.querySelector('#crypto-side-event-stream'),
    };
    if (!el.form || !el.field || !el.chatContent) return;

    const activeModes = new Set();
    const renameInFlight = new Map();
    const activityElementsByThread = new Map();
    const activityDismissedThreads = new Set();
    const answeredApprovalIds = new Set();
    let authoritativeApprovalClose = false;
    let toastTimer = null;
    let activityLayoutTimer = null;
    let renderedThreadId = null;
    let conversationThreadId = null;
    let authoritativeMessageNodes = [];
    let liveMessageNode = null;
    let liveHadDelta = false;
    let dragDepth = 0;
    let attachmentController;
    let voiceController;
    let parserController;
    let cryptoStatus = null;
    let applicationReady = false;
    let deleteAllInFlight = false;
    const cryptoActivities = [];
    const shouldRenderRegion = createRenderGate();
    const controller = createController({
      api,
      stateTools,
      onChange: render,
      confirmDelete: (threadId) => {
        const thread = controller.getState().threads.find((item) => item.id === threadId);
        const title = thread?.title || thread?.name || 'этот диалог';
        return globalScope.confirm(`Удалить «${title}» без возможности восстановления?`);
      },
    });

    function showToast(message) {
      if (!el.toast) return;
      clearTimeout(toastTimer);
      el.toast.textContent = message;
      el.toast.setAttribute('aria-hidden', 'false');
      toastTimer = setTimeout(() => el.toast.setAttribute('aria-hidden', 'true'), 2600);
    }

    function autosize() {
      el.field.style.height = 'auto';
      el.field.style.height = `${Math.min(el.field.scrollHeight, 144)}px`;
    }

    function titleFor(state) {
      const detail = state.details[state.activeThreadId];
      const summary = state.threads.find((thread) => thread.id === state.activeThreadId);
      return detail?.title || detail?.name || summary?.title || summary?.name || 'Новый разговор';
    }

    function setHistoryOpen(open) {
      if (!el.sidebar || !el.historyOpen) return;
      el.sidebar.classList.toggle('is-open', open);
      el.historyOpen.setAttribute('aria-expanded', String(open));
      if (el.historyBackdrop) el.historyBackdrop.hidden = !open;
      document.body.classList.toggle('history-is-open', open);
      if (open) globalScope.requestAnimationFrame?.(() => el.historySearch?.focus({ preventScroll: true }));
    }

    function closeHistory({ restoreFocus = false } = {}) {
      const wasOpen = el.sidebar?.classList.contains('is-open');
      setHistoryOpen(false);
      if (wasOpen && restoreFocus) el.historyOpen?.focus({ preventScroll: true });
    }

    parserController = parserUi.createParserUi({ api, showToast, closeHistory, confirmImpl: globalScope.confirm });

    function createMessageNode(role) {
      const article = document.createElement('article');
      article.className = `message ${role === 'assistant' ? 'assistant' : 'user'}`;
      article.dataset.role = role;
      if (role === 'assistant') {
        const avatar = document.createElement('span');
        avatar.className = 'message-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.append(document.createElement('span'));
        article.append(avatar);
      }
      const body = document.createElement('div');
      body.className = 'message-body';
      const content = document.createElement('p');
      content.className = 'message-content';
      body.append(content);
      article.append(body);
      return article;
    }

    function setMessageNode(article, message, { streaming = false, fallback = false } = {}) {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      article.className = `message ${role}`;
      article.hidden = false;
      article.dataset.role = role;
      const body = article.querySelector('.message-body');
      const content = article.querySelector('.message-content');
      body?.querySelector('.message-path')?.remove();
      body?.querySelector('.crypto-message-chart')?.remove();
      body?.querySelector('.crypto-message-meta')?.remove();
      if (!body || !content) return article;

      if (message.pending) {
        article.classList.add('pending');
        content.hidden = false;
        content.className = 'message-content typing-indicator';
        content.setAttribute('aria-label', 'JARVIS готовит ответ');
        content.replaceChildren();
        for (let index = 0; index < 3; index += 1) {
          const dot = document.createElement('span');
          dot.className = 'typing-dot';
          dot.setAttribute('aria-hidden', 'true');
          content.append(dot);
        }
        return article;
      }

      const cryptoView = role === 'assistant' && conversationThreadId === cryptoStatus?.threadId
        ? cryptoUi.cryptoMessageView(message.text || '')
        : null;
      if (cryptoView?.kind === 'technical') {
        article.hidden = true;
        return article;
      }
      const sourceText = cryptoView?.text ?? message.text ?? '';
      const result = role === 'assistant'
        ? chatView.extractLocalPath(sourceText)
        : { text: String(message.text || ''), path: '' };
      content.className = `message-content${streaming ? ' is-streaming' : ''}`;
      content.removeAttribute('aria-label');
      content.textContent = result.text;
      content.hidden = !result.text;

      if (result.path) {
        const pathSection = document.createElement('div');
        pathSection.className = 'message-path';
        const label = document.createElement('span');
        label.className = 'message-path-label';
        label.textContent = 'Расположение';
        const path = document.createElement('code');
        path.className = 'message-path-value';
        path.textContent = result.path;
        path.title = result.path;
        pathSection.append(label, path);
        body.append(pathSection);
      }

      if (cryptoView?.kind === 'publish') {
        const preview = cryptoStatus?.lastPreview;
        if (preview?.chartUrl && preview.postText === cryptoView.text) {
          const chart = document.createElement('img');
          chart.className = 'crypto-message-chart';
          chart.src = preview.chartUrl;
          chart.alt = 'Validated JARVIS Crypto chart preview';
          chart.loading = 'lazy';
          body.append(chart);
        }
        const details = document.createElement('details');
        details.className = 'crypto-message-meta';
        const summary = document.createElement('summary');
        summary.textContent = 'Technical details';
        const metadata = document.createElement('span');
        metadata.textContent = [
          cryptoView.preset ? `Visual: ${cryptoView.preset.replaceAll('_', ' ')}` : '',
          cryptoView.reason ? `Decision: ${cryptoView.reason.replaceAll('_', ' ')}` : '',
          preview?.postText === cryptoView.text
            ? (preview.validationForcedCandidate
              ? 'Forced validation preview · not a production candidate'
              : 'Validated preview · not published')
            : '',
        ].filter(Boolean).join(' · ');
        details.append(summary, metadata);
        body.append(details);
      }

      if (fallback) {
        article.classList.remove('is-fallback-reveal');
        void article.offsetWidth;
        article.classList.add('is-fallback-reveal');
      }
      return article;
    }

    function messageNode(message, options) {
      return setMessageNode(createMessageNode(message.role), message, options);
    }

    function syncConversation(state, event = {}) {
      const threadId = state.activeThreadId;
      const messages = state.details[threadId]?.messages || [];
      const stream = state.streams[threadId] || '';
      const pending = controller.isPending(threadId);
      const isCrypto = Boolean(threadId && threadId === cryptoStatus?.threadId);

      if (conversationThreadId !== threadId) {
        for (const node of [...authoritativeMessageNodes, liveMessageNode]) node?.remove();
        conversationThreadId = threadId;
        authoritativeMessageNodes = [];
        liveMessageNode = null;
        liveHadDelta = false;
      }

      const finalMessage = messages.at(-1);
      if (event.type === 'assistant-message'
        && event.threadId === threadId
        && liveMessageNode
        && finalMessage?.role === 'assistant') {
        const finalIndex = messages.length - 1;
        setMessageNode(liveMessageNode, finalMessage, { fallback: !liveHadDelta });
        liveMessageNode.dataset.text = String(finalMessage.text || '');
        authoritativeMessageNodes[finalIndex] = liveMessageNode;
        liveMessageNode = null;
        liveHadDelta = false;
      }

      messages.forEach((message, index) => {
        let node = authoritativeMessageNodes[index];
        if (!node || node.dataset.role !== message.role) {
          node?.remove();
          node = messageNode(message);
          authoritativeMessageNodes[index] = node;
        } else if (
          node.dataset.text !== String(message.text || '')
          || node.dataset.decoration !== (isCrypto && message.role === 'assistant' && cryptoStatus?.lastPreview?.postText === cryptoUi.publicCryptoMessage(message.text || '')
            ? String(cryptoStatus.lastPreview.chartUrl || 'preview')
            : '')
        ) {
          setMessageNode(node, message);
        }
        node.dataset.text = String(message.text || '');
        node.dataset.decoration = isCrypto && message.role === 'assistant' && cryptoStatus?.lastPreview?.postText === cryptoUi.publicCryptoMessage(message.text || '')
          ? String(cryptoStatus.lastPreview.chartUrl || 'preview')
          : '';
      });
      for (const node of authoritativeMessageNodes.splice(messages.length)) node?.remove();

      if (stream) {
        if (!liveMessageNode) liveMessageNode = messageNode({ role: 'assistant', pending: true });
        if (liveMessageNode.dataset.text !== stream || !liveMessageNode.querySelector('.message-content')?.classList.contains('is-streaming')) {
          setMessageNode(liveMessageNode, { role: 'assistant', text: stream }, { streaming: true });
          liveMessageNode.dataset.text = stream;
        }
        liveHadDelta = true;
      } else if (pending) {
        if (!liveMessageNode) liveMessageNode = messageNode({ role: 'assistant', pending: true });
        if (!liveHadDelta && !liveMessageNode.classList.contains('pending')) {
          setMessageNode(liveMessageNode, { role: 'assistant', pending: true });
        }
      } else if (liveMessageNode) {
        liveMessageNode.remove();
        liveMessageNode = null;
        liveHadDelta = false;
      }

      reconcileChildOrder(el.chatContent, [el.welcome, el.cryptoContext, ...authoritativeMessageNodes, liveMessageNode]);
      return isCrypto || messages.length > 0 || Boolean(stream) || pending;
    }

    function renderHistory(state) {
      if (!el.historyList) return;
      const ordinaryThreads = state.threads.filter((thread) => thread.id !== cryptoStatus?.threadId);
      if (el.deleteAllThreads) {
        el.deleteAllThreads.disabled = ordinaryThreads.length === 0 || deleteAllInFlight;
        el.deleteAllThreads.dataset.count = String(ordinaryThreads.length);
      }
      const renderKey = JSON.stringify([
        state.activeThreadId,
        cryptoStatus?.threadId,
        el.historySearch?.value || '',
        ordinaryThreads.map((thread) => [thread.id, thread.title, thread.name, thread.preview]),
      ]);
      if (!shouldRenderRegion('history', renderKey)) return;
      el.historyList.replaceChildren();
      if (ordinaryThreads.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'history-empty';
        empty.textContent = el.historySearch?.value ? 'Ничего не найдено' : 'Диалогов пока нет';
        el.historyList.append(empty);
        return;
      }

      for (const thread of ordinaryThreads) {
        const row = document.createElement('div');
        row.className = `history-row${thread.id === state.activeThreadId ? ' is-current' : ''}`;
        row.setAttribute('role', 'listitem');
        const title = thread.title || thread.name || thread.preview || 'Новый разговор';
        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'history-select';
        select.textContent = title;
        select.title = title;
        if (thread.id === state.activeThreadId) select.setAttribute('aria-current', 'page');
        select.addEventListener('click', () => {
          closeHistory();
          controller.selectThread(thread.id).catch((error) => showToast(error.message));
        });

        const rename = document.createElement('input');
        rename.className = 'history-rename';
        rename.value = thread.title || thread.name || '';
        rename.setAttribute('aria-label', `Переименовать ${title}`);
        rename.maxLength = 120;
        rename.hidden = true;
        const persistRename = () => {
          const value = rename.value.trim();
          rename.hidden = true;
          select.hidden = false;
          if (!value || renameInFlight.get(thread.id) === value || value === (thread.title || thread.name)) return;
          renameInFlight.set(thread.id, value);
          controller.renameThread(thread.id, value)
            .catch((error) => showToast(error.message))
            .finally(() => renameInFlight.delete(thread.id));
        };
        rename.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); persistRename(); rename.blur(); }
          if (event.key === 'Escape') {
            event.preventDefault();
            rename.value = thread.title || thread.name || '';
            rename.hidden = true;
            select.hidden = false;
            select.focus();
          }
        });
        rename.addEventListener('blur', persistRename);

        const menu = document.createElement('details');
        menu.className = 'history-menu';
        const summary = document.createElement('summary');
        summary.setAttribute('aria-label', `Действия для диалога ${title}`);
        summary.title = 'Действия с диалогом';
        const dots = document.createElement('span');
        dots.setAttribute('aria-hidden', 'true');
        dots.textContent = '•••';
        summary.append(dots);
        const menuItems = document.createElement('div');
        menuItems.className = 'history-menu-items';
        menuItems.setAttribute('role', 'menu');

        const renameAction = document.createElement('button');
        renameAction.type = 'button';
        renameAction.setAttribute('role', 'menuitem');
        renameAction.textContent = 'Переименовать';
        renameAction.addEventListener('click', () => {
          menu.open = false;
          select.hidden = true;
          rename.hidden = false;
          rename.focus();
          rename.select();
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'history-delete';
        remove.setAttribute('role', 'menuitem');
        remove.textContent = 'Удалить';
        remove.setAttribute('aria-label', `Удалить диалог ${title}`);
        remove.addEventListener('click', () => {
          menu.open = false;
          controller.deleteThread(thread.id).catch((error) => showToast(error.message));
        });
        menuItems.append(renameAction, remove);
        menu.append(summary, menuItems);
        row.append(select, rename, menu);
        el.historyList.append(row);
      }
    }

    const ACTIVITY_ICONS = Object.freeze({
      web: '⌕',
      command: '›',
      file: '▱',
      approval: '!',
      queue: '≡',
      transcription: '●',
    });

    const ACTIVITY_STATES = Object.freeze({
      working: 'Выполняется',
      completed: 'Готово',
      error: 'Ошибка',
    });

    function createActivityElement(activity) {
      const item = document.createElement('li');
      item.className = 'activity-entry';
      item.dataset.activityId = activity.id;
      const icon = document.createElement('span');
      icon.className = 'activity-icon';
      icon.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'activity-entry-copy';
      copy.append(document.createElement('strong'), document.createElement('small'));
      const state = document.createElement('span');
      state.className = 'activity-state';
      item.append(icon, copy, state);
      return item;
    }

    function updateActivityElement(item, activity) {
      const normalizedState = chatView.normalizeActivityState(activity.state);
      item.dataset.state = normalizedState;
      item.dataset.category = activity.category || 'activity';
      item.querySelector('.activity-icon').textContent = ACTIVITY_ICONS[activity.category] || '·';
      item.querySelector('.activity-entry-copy strong').textContent = activity.title || 'Действие';
      item.querySelector('.activity-entry-copy small').textContent = activity.detail || '';
      item.querySelector('.activity-state').textContent = ACTIVITY_STATES[normalizedState];
      return item;
    }

    function setActivityPanelOpen(open) {
      if (!el.activityPanel || !el.activityOpen || !el.appShell) return;
      const wasOpen = el.appShell.classList.contains('has-activity-panel');
      const nearBottom = el.chatScroll
        ? el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight < 48
        : false;
      const scrollTop = el.chatScroll?.scrollTop || 0;
      el.activityPanel.hidden = false;
      el.appShell.classList.toggle('has-activity-panel', open);
      el.appShell.classList.toggle('activity-collapsed', open && el.activityPanel.classList.contains('is-collapsed'));
      el.activityPanel.classList.toggle('is-open', open);
      el.activityPanel.setAttribute('aria-hidden', String(!open));
      el.activityOpen.setAttribute('aria-expanded', String(open));
      if (wasOpen === open || !el.chatScroll) return;
      if (activityLayoutTimer) globalScope.clearTimeout(activityLayoutTimer);
      activityLayoutTimer = globalScope.setTimeout(() => {
        if (!el.chatScroll) return;
        el.chatScroll.scrollTop = nearBottom ? el.chatScroll.scrollHeight : scrollTop;
        activityLayoutTimer = null;
      }, 220);
    }

    function renderActivity(state, event = {}) {
      if (!el.activitySteps) return;
      const threadId = state.activeThreadId;
      if (!threadId) {
        if (shouldRenderRegion('activity', '')) el.activitySteps.replaceChildren();
        if (el.activityOpen) el.activityOpen.hidden = true;
        setActivityPanelOpen(false);
        return;
      }
      const activities = chatView.recentActivities(state.activities[threadId] || []).slice(-5);
      const renderKey = JSON.stringify([threadId, activities]);
      let elements = activityElementsByThread.get(threadId);
      if (!elements) {
        elements = new Map();
        activityElementsByThread.set(threadId, elements);
      }

      if (shouldRenderRegion('activity', renderKey)) {
        const visibleIds = new Set(activities.map(({ id }) => id));
        for (const [id, item] of elements) {
          if (!visibleIds.has(id)) {
            item.remove();
            elements.delete(id);
          }
        }
        for (const activity of activities) {
          let item = elements.get(activity.id);
          if (!item) {
            item = createActivityElement(activity);
            elements.set(activity.id, item);
          }
          updateActivityElement(item, activity);
        }
        reconcileChildOrder(el.activitySteps, activities.map(({ id }) => elements.get(id)));
      }

      const hasActivity = activities.length > 0;
      if (el.activityOpen) {
        el.activityOpen.hidden = !hasActivity;
        el.activityOpen.classList.toggle('has-activity', hasActivity);
      }
      if (!hasActivity) {
        setActivityPanelOpen(false);
      } else if (event.type === 'activity' && event.threadId === threadId && !activityDismissedThreads.has(threadId)) {
        setActivityPanelOpen(true);
      }
    }

    function renderQueue(state) {
      if (!el.queueTray) return;
      const threadId = state.activeThreadId;
      const items = state.queues[threadId] || [];
      const renderKey = JSON.stringify([threadId, items]);
      if (!shouldRenderRegion('queue', renderKey)) return;
      el.queueTray.replaceChildren();
      el.queueTray.hidden = items.length === 0;
      for (const item of items) {
        const row = document.createElement('li');
        row.className = 'queue-item';
        const copy = document.createElement('span');
        copy.className = 'queue-item-copy';
        const rawText = item.message === chatView.ATTACHMENT_ONLY_INSTRUCTION ? chatView.ATTACHMENT_ONLY_LABEL : item.message;
        const text = String(rawText || '').replace(/\s+/g, ' ').trim();
        const imageCount = Array.isArray(item.attachments) ? item.attachments.length : 0;
        copy.textContent = `${text.slice(0, 80)}${text.length > 80 ? '…' : ''}${imageCount ? ` · изображений: ${imageCount}` : ''}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'queue-remove';
        remove.textContent = '×';
        remove.title = 'Убрать из очереди';
        remove.setAttribute('aria-label', 'Убрать сообщение из очереди');
        remove.addEventListener('click', () => controller.removeQueued(threadId, item.id).catch((error) => showToast(error.message)));
        row.append(copy, remove);
        el.queueTray.append(row);
      }
    }

    function renderAttachments(snapshot = attachmentController?.getSnapshot()) {
      if (!el.attachmentPreview || !snapshot) return;
      el.attachmentPreview.replaceChildren();
      el.attachmentPreview.hidden = snapshot.attachments.length === 0;
      for (const item of snapshot.attachments) {
        const row = document.createElement('li');
        row.className = 'attachment-preview-item';
        const image = document.createElement('img');
        image.src = item.previewUrl;
        image.alt = item.name || 'Прикреплённое изображение';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'attachment-remove';
        remove.textContent = '×';
        remove.title = 'Убрать изображение';
        remove.setAttribute('aria-label', `Убрать изображение ${item.name || ''}`.trim());
        remove.addEventListener('click', () => attachmentController.remove(item.id).catch((error) => showMediaError(error.message)));
        row.append(image, remove);
        el.attachmentPreview.append(row);
      }
    }

    function formatDuration(milliseconds) {
      const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
      return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }

    function renderMediaState(mediaState = voiceController?.getState() || { mode: 'idle', elapsedMs: 0, message: '' }) {
      el.form.dataset.composerState = mediaState.mode;
      if (el.recordingTimer) {
        el.recordingTimer.hidden = mediaState.mode !== 'recording';
        el.recordingTimer.textContent = formatDuration(mediaState.elapsedMs);
      }
      if (el.mediaStatus) {
        el.mediaStatus.textContent = mediaState.message || '';
        el.mediaStatus.dataset.state = mediaState.error ? 'error' : mediaState.mode;
      }
      const recording = mediaState.mode === 'recording';
      if (el.sendIcon) el.sendIcon.hidden = recording;
      if (el.checkIcon) el.checkIcon.hidden = !recording;
      if (el.send) {
        el.send.disabled = mediaState.mode === 'transcribing' || mediaState.mode === 'sending';
        el.send.setAttribute('aria-label', recording ? 'Завершить запись' : 'Отправить сообщение');
        el.send.title = recording ? 'Завершить запись' : 'Отправить';
      }
      if (el.micButton) {
        el.micButton.disabled = mediaState.mode === 'transcribing' || mediaState.mode === 'sending';
        el.micButton.setAttribute('aria-pressed', String(recording));
        el.micButton.setAttribute('aria-label', recording ? 'Отменить запись голоса' : 'Записать голос');
        el.micButton.title = recording ? 'Отменить запись' : 'Записать голос';
      }
      document.querySelectorAll('.mode-button[data-mode]').forEach((button) => { button.disabled = mediaState.mode !== 'idle'; });
    }

    function showMediaError(message) {
      if (!el.mediaStatus) return;
      el.mediaStatus.textContent = message;
      el.mediaStatus.dataset.state = 'error';
    }

    function showApproval(approval, threadId) {
      el.dialog.dataset.approvalId = String(approval.id);
      el.dialog.dataset.approvalThreadId = threadId;
      if (el.approvalAllow) {
        el.approvalAllow.disabled = approval.canAcceptOnce === false;
        el.approvalAllow.title = approval.canAcceptOnce === false
          ? 'Одноразовое разрешение недоступно для этого запроса'
          : '';
      }
      el.approvalReason.textContent = approval.reason || 'JARVIS запрашивает разрешение на действие.';
      el.approvalCommand.textContent = [approval.command, approval.cwd, approval.target].filter(Boolean).join('\n') || 'Локальное действие';
      el.dialog.showModal();
    }

    function threadCountLabel(count) {
      const lastTwo = count % 100;
      const last = count % 10;
      if (lastTwo >= 11 && lastTwo <= 14) return `${count} диалогов`;
      if (last === 1) return `${count} диалог`;
      if (last >= 2 && last <= 4) return `${count} диалога`;
      return `${count} диалогов`;
    }

    function openDeleteAllDialog() {
      if (!el.deleteAllDialog || deleteAllInFlight) return;
      const count = controller.getState().threads.filter((thread) => thread.id !== cryptoStatus?.threadId).length;
      if (el.deleteAllCount) el.deleteAllCount.textContent = threadCountLabel(count);
      if (el.deleteAllConfirm) el.deleteAllConfirm.disabled = count === 0;
      if (!el.deleteAllDialog.open) el.deleteAllDialog.showModal();
    }

    function scrollConversationToEnd() {
      globalScope.requestAnimationFrame?.(() => {
        if (!el.chatScroll) return;
        const reduced = globalScope.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        if (typeof el.chatScroll.scrollTo === 'function') {
          el.chatScroll.scrollTo({ top: el.chatScroll.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
        } else {
          el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
        }
      });
    }

    function render(state, event = {}) {
      if (event.type === 'approval-resolved') {
        answeredApprovalIds.delete(`${event.threadId}:${event.id}`);
        const ownsOpenDialog = el.dialog?.open
          && el.dialog.dataset.approvalThreadId === event.threadId
          && String(el.dialog.dataset.approvalId) === String(event.id);
        if (ownsOpenDialog) {
          authoritativeApprovalClose = true;
          el.dialog.close();
        }
      }
      if (event.type === 'crypto-activity') {
        cryptoActivities.push(event);
        cryptoActivities.splice(0, Math.max(0, cryptoActivities.length - 24));
        void refreshCryptoStatus().then(() => {
          if (
            event.threadId
            && ['writer_completed', 'post_preview_ready', 'publication_result', 'publish_completed', 'publish_failed', 'publish_unknown'].includes(event.eventType)
          ) controller.reloadThread(event.threadId).catch(() => {});
        }).catch(() => {});
      }
      if (event.type === 'thread-deleted' && event.threadId) {
        activityElementsByThread.delete(event.threadId);
        activityDismissedThreads.delete(event.threadId);
      }
      const threadId = state.activeThreadId;
      const detail = state.details[threadId];
      const title = titleFor(state);
      if (!parserController?.isActive() && el.conversationTitle && el.conversationTitle.textContent !== title) el.conversationTitle.textContent = title;
      renderHistory(state);
      renderCryptoCard(state);

      const hasConversation = syncConversation(state, event);
      if (el.welcome) el.welcome.hidden = hasConversation;
      el.chatContent.classList.toggle('has-messages', hasConversation);
      el.chatContent.classList.toggle('crypto-active', Boolean(threadId && threadId === cryptoStatus?.threadId));

      const draft = state.drafts[threadId] || '';
      if (el.field.value !== draft) {
        el.field.value = draft;
        autosize();
      }
      const status = state.statuses[threadId] || detail?.status || { state: 'ready', detail: 'Готов к работе' };
      if (!parserController?.isActive() && el.status) el.status.dataset.state = status.state || 'ready';
      const nextStatusText = status.detail || 'Готов к работе';
      if (!parserController?.isActive() && el.statusText && el.statusText.textContent !== nextStatusText) el.statusText.textContent = nextStatusText;
      el.form.classList.toggle('is-working', status.state === 'working');
      renderActivity(state, event);
      renderQueue(state);
      const approval = state.approvals[threadId];
      const approvalKey = approval ? `${threadId}:${approval.id}` : '';
      if (approval && el.dialog && !el.dialog.open && !answeredApprovalIds.has(approvalKey)) showApproval(approval, threadId);
      if (['thread-selected', 'thread-detail', 'message-submitted', 'turn-started', 'assistant-delta', 'assistant-message'].includes(event.type)) {
        scrollConversationToEnd();
      }
      if (threadId !== renderedThreadId && attachmentController) {
        renderedThreadId = threadId;
        attachmentController.switchThread(threadId).catch(() => {});
      }
      parserController?.handleEvent(event);
    }

    function renderCryptoCard(state = controller.getState()) {
      const active = Boolean(cryptoStatus?.threadId && state.activeThreadId === cryptoStatus.threadId);
      if (el.cryptoContext) {
        el.cryptoContext.hidden = !active;
        el.cryptoContext.dataset.state = cryptoStatus?.scanner || 'stopped';
      }
      if (el.cryptoOpen) {
        el.cryptoOpen.disabled = !applicationReady || !cryptoStatus?.threadId;
        el.cryptoOpen.dataset.state = cryptoStatus?.scanner || 'stopped';
        el.cryptoOpen.classList.toggle('is-current', active);
        if (active) el.cryptoOpen.setAttribute('aria-current', 'page');
        else el.cryptoOpen.removeAttribute('aria-current');
      }
      if (!cryptoStatus) return;

      const statusLabel = cryptoUi.cryptoStatusLabel(cryptoStatus);
      if (el.cryptoStatusText) el.cryptoStatusText.textContent = statusLabel;
      if (el.cryptoContextStatus) el.cryptoContextStatus.textContent = statusLabel;
      if (el.cryptoScanner) el.cryptoScanner.textContent = cryptoStatus.scanner === 'running' ? 'Running' : 'Stopped';
      if (el.cryptoModeLabel) el.cryptoModeLabel.textContent = `AUTO: ${cryptoStatus.autoArmed ? 'ON' : 'OFF'}`;
      if (el.cryptoPosts) el.cryptoPosts.textContent = `${cryptoStatus.posts24h ?? 0} / ${cryptoStatus.maxPosts24h ?? 10}`;
      if (el.cryptoSlots) el.cryptoSlots.textContent = `${cryptoStatus.slotsRemaining ?? 0} remaining`;
      if (el.cryptoCredential) {
        el.cryptoCredential.textContent = cryptoStatus.publishAvailability === 'PUBLISH_READY'
          ? 'Ready'
          : cryptoStatus.pendingPublish ? 'Review required' : 'Not configured';
      }

      document.querySelectorAll('[data-crypto-mode]').forEach((button) => {
        const isActiveMode = button.dataset.cryptoMode === cryptoStatus.mode;
        button.classList.toggle('is-active', isActiveMode);
        button.setAttribute('aria-pressed', String(isActiveMode));
        button.disabled = button.dataset.cryptoMode === 'AUTO'
          && (cryptoStatus.squareCredentialConfigured !== true
            || cryptoStatus.publishAvailability?.startsWith('PUBLISH_DISABLED: recovery_blocked')
            || cryptoStatus.publishAvailability?.startsWith('PUBLISH_DISABLED: unresolved_publish'));
      });
      if (el.cryptoEnableAuto) {
        el.cryptoEnableAuto.disabled = cryptoStatus.squareCredentialConfigured !== true;
        el.cryptoEnableAuto.textContent = cryptoStatus.autoArmed ? 'DISABLE AUTO' : 'ENABLE AUTO';
      }
      if (el.cryptoResetPostLimit) el.cryptoResetPostLimit.disabled = Boolean(cryptoStatus.pendingPublish);

      const storedEvents = (cryptoStatus.recentEvents || []).map((event) => ({
        ...event,
        eventType: event.type,
      }));
      const events = cryptoUi.meaningfulCryptoEvents([...storedEvents, ...cryptoActivities], 40);
      const latestWriter = [...events].reverse().find((event) => ['writer_started', 'writer_completed', 'writer_unavailable', 'candidate_queued'].includes(event.eventType || event.type));
      if (el.cryptoCodex) {
        const writer = cryptoStatus.writer || {};
        const offline = writer.state === 'offline' || latestWriter?.eventType === 'writer_unavailable';
        el.cryptoCodex.textContent = writer.provider === 'ollama' ? 'Gemma 4 12B · Local' : 'Local writer';
        if (el.cryptoOllama) {
          el.cryptoOllama.textContent = offline
            ? 'Offline'
            : latestWriter?.eventType === 'writer_started'
              ? 'Writing'
              : 'Ready';
        }
      }
      const renderCryptoEvents = (target, streamEvents, region) => {
        if (!target) return;
        const key = JSON.stringify(streamEvents.map((event) => [event.eventId, event.eventType || event.type, event.occurredAt, event.payload?.symbol]));
        if (shouldRenderRegion(region, key)) {
          target.replaceChildren(...streamEvents.map((event) => {
            const item = document.createElement('li');
            item.dataset.eventType = event.eventType || event.type || 'update';
            const timeline = cryptoUi.cryptoTimelineEntry(event);
            const time = document.createElement('time');
            const date = new Date(event.occurredAt);
            time.dateTime = Number.isNaN(date.getTime()) ? '' : date.toISOString();
            time.textContent = timeline.time;
            const copy = document.createElement('span');
            copy.className = 'crypto-event-copy';
            const title = document.createElement('strong');
            title.textContent = timeline.title;
            copy.append(title);
            if (timeline.detail) {
              const detail = document.createElement('span');
              detail.textContent = timeline.detail;
              copy.append(detail);
            }
            item.append(time, copy);
            return item;
          }));
        }
      };
      renderCryptoEvents(el.cryptoEventStream, events, 'crypto-activity');
      const sideEvents = [...events].reverse().filter((event) => cryptoUi.cryptoTimelineEntry(event).title !== 'Crypto update').slice(0, 4);
      renderCryptoEvents(el.cryptoSideEventStream, sideEvents.length ? sideEvents : events.slice(-4).reverse(), 'crypto-side-activity');
    }

    async function refreshCryptoStatus() {
      cryptoStatus = await api.cryptoStatus();
      render(controller.getState(), { type: 'crypto-status' });
      return cryptoStatus;
    }

    function contextualMessage(message) {
      const instructions = [];
      if (activeModes.has('files')) instructions.push('Работай с локальными файлами в рамках разрешённых действий.');
      if (activeModes.has('web')) instructions.push('Используй веб-поиск для актуальной информации.');
      return instructions.length ? `${instructions.join(' ')}\n\nЗапрос пользователя: ${message}` : message;
    }

    attachmentController = chatView.createAttachmentController({
      api,
      getThreadId: () => controller.getState().activeThreadId,
      onChange: renderAttachments,
    });
    voiceController = chatView.createVoiceController({
      mediaDevices: globalScope.navigator?.mediaDevices,
      MediaRecorderImpl: globalScope.MediaRecorder,
      transcribe: (audio) => api.transcribe(audio),
      getSelection: () => ({
        value: el.field.value,
        selectionStart: el.field.selectionStart,
        selectionEnd: el.field.selectionEnd,
      }),
      insertTranscript: ({ value, selectionStart, selectionEnd }) => {
        el.field.value = value;
        controller.changeDraft(value);
        autosize();
        el.field.focus({ preventScroll: true });
        el.field.setSelectionRange(selectionStart, selectionEnd);
      },
      onStateChange: renderMediaState,
    });

    el.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (voiceController.getState().mode === 'recording') {
        await voiceController.check();
        return;
      }
      if (voiceController.getState().mode !== 'idle') return;
      const visible = el.field.value.trim();
      const attachments = attachmentController.getSnapshot().attachments;
      if (!visible && attachments.length === 0) return;
      const visibleText = visible || chatView.ATTACHMENT_ONLY_LABEL;
      const serverMessage = visible ? contextualMessage(visible) : chatView.ATTACHMENT_ONLY_INSTRUCTION;
      let sendError = null;
      voiceController.setSending(true);
      try {
        await controller.send({
          attachmentIds: attachments.map((item) => item.id),
          serverMessage,
          visibleText,
        });
        attachmentController.commit(attachments.map((item) => item.id));
        activeModes.clear();
        document.querySelectorAll('.mode-button[data-mode]').forEach((button) => {
          button.classList.remove('is-active');
          button.setAttribute('aria-pressed', 'false');
        });
        el.field.focus({ preventScroll: true });
      } catch (error) {
        sendError = error;
      } finally {
        voiceController.setSending(false);
        if (sendError) showMediaError(sendError.message);
        el.field.focus({ preventScroll: true });
      }
    });
    el.field.addEventListener('input', () => { controller.changeDraft(el.field.value); autosize(); });
    el.field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); el.form.requestSubmit(); }
    });
    el.attachButton?.addEventListener('click', () => el.attachmentInput?.click());
    el.attachmentInput?.addEventListener('change', async () => {
      const result = await attachmentController.acceptFiles(el.attachmentInput.files);
      el.attachmentInput.value = '';
      if (result.rejected.length) showMediaError(result.rejected.map((item) => item.message).join(' '));
    });
    el.field.addEventListener('paste', (event) => {
      const images = Array.from(event.clipboardData?.files || []).filter((file) => file.type?.startsWith('image/'));
      if (!images.length) return;
      event.preventDefault();
      attachmentController.acceptFiles(images).then((result) => {
        if (result.rejected.length) showMediaError(result.rejected.map((item) => item.message).join(' '));
      });
    });
    el.micButton?.addEventListener('click', () => {
      const action = voiceController.getState().mode === 'recording' ? voiceController.cancel() : voiceController.start();
      Promise.resolve(action).catch((error) => showMediaError(error.message));
    });
    el.form.addEventListener('dragenter', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      if (el.dragOverlay) el.dragOverlay.hidden = false;
    });
    el.form.addEventListener('dragover', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    el.form.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && el.dragOverlay) el.dragOverlay.hidden = true;
    });
    el.form.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      if (el.dragOverlay) el.dragOverlay.hidden = true;
      attachmentController.acceptFiles(event.dataTransfer?.files).then((result) => {
        if (result.rejected.length) showMediaError(result.rejected.map((item) => item.message).join(' '));
      });
    });
    el.newChat?.addEventListener('click', () => {
      closeHistory();
      controller.newThread().then(() => el.field.focus()).catch((error) => showToast(error.message));
    });
    el.historyOpen?.addEventListener('click', () => setHistoryOpen(!el.sidebar?.classList.contains('is-open')));
    el.historyClose?.addEventListener('click', () => closeHistory({ restoreFocus: true }));
    el.historyBackdrop?.addEventListener('click', () => closeHistory({ restoreFocus: true }));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && voiceController.getState().mode === 'recording') {
        event.preventDefault();
        voiceController.cancel().catch((error) => showMediaError(error.message));
        return;
      }
      if (event.key === 'Escape' && el.sidebar?.classList.contains('is-open')) {
        event.preventDefault();
        closeHistory({ restoreFocus: true });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        parserController?.close();
        controller.newThread().then(() => el.field.focus()).catch((error) => showToast(error.message));
      }
    });
    el.historySearch?.addEventListener('input', () => controller.search(el.historySearch.value).catch((error) => showToast(error.message)));
    document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
      controller.changeDraft(button.dataset.prompt || ''); el.field.focus();
    }));
    document.querySelectorAll('.mode-button[data-mode]').forEach((button) => button.addEventListener('click', () => {
      const mode = button.dataset.mode;
      if (activeModes.has(mode)) activeModes.delete(mode); else activeModes.add(mode);
      button.classList.toggle('is-active', activeModes.has(mode));
      button.setAttribute('aria-pressed', String(activeModes.has(mode)));
      el.field.focus();
    }));
    el.activityOpen?.addEventListener('click', () => {
      const threadId = controller.getState().activeThreadId;
      activityDismissedThreads.delete(threadId);
      setActivityPanelOpen(true);
    });
    el.activityClose?.addEventListener('click', () => {
      activityDismissedThreads.add(controller.getState().activeThreadId);
      setActivityPanelOpen(false);
      el.activityOpen?.focus({ preventScroll: true });
    });
    el.activityToggle?.addEventListener('click', () => {
      const collapsed = el.activityPanel.classList.toggle('is-collapsed');
      el.appShell?.classList.toggle('activity-collapsed', collapsed);
      el.activityToggle.setAttribute('aria-expanded', String(!collapsed));
      el.activityToggle.setAttribute('aria-label', collapsed ? 'Развернуть активность' : 'Свернуть активность');
      el.activityToggle.title = collapsed ? 'Развернуть активность' : 'Свернуть активность';
    });
    el.activityClear?.addEventListener('click', () => {
      const threadId = controller.getState().activeThreadId;
      activityElementsByThread.get(threadId)?.clear();
      activityDismissedThreads.delete(threadId);
      controller.clearActivity(threadId);
      el.field.focus({ preventScroll: true });
    });
    el.deleteAllThreads?.addEventListener('click', openDeleteAllDialog);
    el.deleteAllCancel?.addEventListener('click', () => el.deleteAllDialog?.close('cancel'));
    el.deleteAllConfirm?.addEventListener('click', async () => {
      if (deleteAllInFlight) return;
      deleteAllInFlight = true;
      el.deleteAllConfirm.disabled = true;
      if (el.deleteAllCancel) el.deleteAllCancel.disabled = true;
      const originalLabel = el.deleteAllConfirm.textContent;
      el.deleteAllConfirm.textContent = 'Удаляем…';
      try {
        const result = await controller.deleteAllThreads();
        el.deleteAllDialog?.close('deleted');
        closeHistory();
        showToast(`Удалено: ${result.deletedCount || 0}`);
      } catch (error) {
        showToast(error.message);
      } finally {
        deleteAllInFlight = false;
        el.deleteAllConfirm.textContent = originalLabel;
        el.deleteAllConfirm.disabled = false;
        if (el.deleteAllCancel) el.deleteAllCancel.disabled = false;
        render(controller.getState(), { type: 'delete-all-finished' });
      }
    });
    el.cryptoOpen?.addEventListener('click', () => {
      if (!cryptoStatus?.threadId) return;
      closeHistory();
      controller.selectThread(cryptoStatus.threadId).catch((error) => showToast(error.message));
    });
    document.querySelectorAll('[data-crypto-mode]').forEach((button) => button.addEventListener('click', async () => {
      const controls = [...document.querySelectorAll('[data-crypto-mode]')];
      controls.forEach((control) => { control.disabled = true; });
      try {
        const mode = button.dataset.cryptoMode;
        if (mode === 'AUTO') {
          if (!cryptoStatus?.autoReady && !globalScope.confirm('Готовность к публикации не подтверждена. Включить AUTO всё равно?')) return;
          cryptoStatus = await api.confirmCryptoAuto(!cryptoStatus?.autoReady);
        } else {
          cryptoStatus = await api.setCryptoMode(mode);
        }
        renderCryptoCard();
      } catch (error) {
        showToast(error.message);
        await refreshCryptoStatus().catch(() => {});
      } finally {
        renderCryptoCard();
      }
    }));
    el.cryptoDryRun?.addEventListener('click', async () => {
      el.cryptoDryRun.disabled = true;
      el.cryptoDryRun.textContent = 'Checking live data…';
      try {
        await api.runCryptoDryRun();
        await refreshCryptoStatus();
        showToast('Crypto dry run verified. Nothing was published.');
      } catch (error) {
        showToast(error.message);
      } finally {
        el.cryptoDryRun.disabled = false;
        el.cryptoDryRun.textContent = 'Verify live dry run';
      }
    });
    el.cryptoResetPostLimit?.addEventListener('click', async () => {
      el.cryptoResetPostLimit.disabled = true;
      el.cryptoResetPostLimit.textContent = 'Resetting…';
      try {
        cryptoStatus = await api.resetCryptoPostLimit();
        renderCryptoCard();
        showToast('Лимит публикаций обновлён: 0/10.');
      } catch (error) {
        showToast(error.message);
        await refreshCryptoStatus().catch(() => {});
      } finally {
        el.cryptoResetPostLimit.textContent = 'RESET 10/10';
        if (cryptoStatus) renderCryptoCard();
      }
    });
    el.cryptoEnableAuto?.addEventListener('click', async () => {
      if (cryptoStatus?.autoArmed) {
        cryptoStatus = await api.setCryptoMode('DRY_RUN');
        renderCryptoCard();
        showToast('AUTO выключен.');
        return;
      }
      if (!cryptoStatus?.autoReady && !globalScope.confirm('Готовность к публикации не подтверждена. Включить AUTO всё равно?')) return;
      el.cryptoEnableAuto.disabled = true;
      try {
        cryptoStatus = await api.confirmCryptoAuto(!cryptoStatus?.autoReady);
        renderCryptoCard();
        showToast('AUTO enabled manually.');
      } catch (error) {
        showToast(error.message);
        await refreshCryptoStatus().catch(() => {});
      }
    });
    el.dialog?.addEventListener('close', async () => {
      if (authoritativeApprovalClose) {
        authoritativeApprovalClose = false;
        return;
      }
      const id = Number(el.dialog.dataset.approvalId);
      const threadId = el.dialog.dataset.approvalThreadId;
      const decision = el.dialog.returnValue === 'allow' ? 'accept' : 'decline';
      const approvalKey = `${threadId}:${id}`;
      answeredApprovalIds.add(approvalKey);
      try {
        await controller.resolveApproval(threadId, id, decision);
      } catch (error) {
        answeredApprovalIds.delete(approvalKey);
        showToast(error.message);
        const pending = controller.getState().approvals[threadId];
        if (pending && !el.dialog.open) showApproval(pending, threadId);
      }
    });
    el.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
    });

    autosize();
    renderAttachments();
    renderMediaState();
    refreshCryptoStatus()
      .catch((error) => { showToast(error.message); return null; })
      .then(() => controller.boot({ excludedThreadIds: cryptoStatus?.threadId ? [cryptoStatus.threadId] : [] }))
      .then(() => {
        applicationReady = true;
        render(controller.getState(), { type: 'boot-ready' });
      })
      .catch((error) => showToast(error.message));
  }
})(globalThis);
