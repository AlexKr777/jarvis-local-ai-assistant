export const IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const ATTACHMENT_ONLY_LABEL = 'Изображение';
export const ATTACHMENT_ONLY_INSTRUCTION = 'Кратко проанализируй приложенные изображения.';

const WINDOWS_PATH = /^(?:[a-z]:\\|\\\\)[^\r\n]+$/i;
const POSIX_PATH = /^\/(?:Users|home|tmp|var|opt|mnt|workspace|app)(?:\/[^\r\n]+)+$/;
const PATH_LABEL = /^(?:путь|файл|папка|расположение|сохранено|создано)\s*:\s*/i;

function cleanPathLine(line) {
  return String(line || '')
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(PATH_LABEL, '')
    .replace(/^`{1,3}|`{1,3}$/g, '')
    .replace(/^["«]|["»]$/g, '')
    .replace(/[;,)]$/g, '')
    .trim();
}

export function extractLocalPath(value) {
  const source = String(value ?? '');
  const lines = source.split(/\r?\n/);
  let path = '';
  let pathIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = cleanPathLine(lines[index]);
    if (WINDOWS_PATH.test(candidate) || POSIX_PATH.test(candidate)) {
      path = candidate;
      pathIndex = index;
      break;
    }
  }

  if (!path) return { text: source, path: '' };
  const text = lines
    .filter((_, index) => index !== pathIndex)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, path };
}

export function normalizeActivityState(value) {
  const state = String(value || '').toLowerCase();
  if (['complete', 'completed', 'done', 'success'].includes(state)) return 'completed';
  if (['error', 'failed', 'declined'].includes(state)) return 'error';
  return 'working';
}

export function recentActivities(items, limit = 5) {
  const byId = new Map();
  for (const activity of Array.isArray(items) ? items : []) {
    const id = String(activity?.id || '').trim();
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...activity, id });
  }
  return Array.from(byId.values()).slice(-Math.max(0, limit));
}

function publicError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function insertAtSelection(value, selectionStart, selectionEnd, transcript) {
  const source = String(value ?? '');
  const start = Math.max(0, Math.min(Number(selectionStart) || 0, source.length));
  const end = Math.max(start, Math.min(Number(selectionEnd) || start, source.length));
  const text = String(transcript || '').trim();
  if (!text) return { value: source, selectionStart: start, selectionEnd: end };

  const before = source.slice(0, start);
  const after = source.slice(end);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const insertion = `${needsLeadingSpace ? ' ' : ''}${text}${needsTrailingSpace ? ' ' : ''}`;
  const nextValue = `${before}${insertion}${after}`;
  const caret = before.length + insertion.length;
  return { value: nextValue, selectionStart: caret, selectionEnd: caret };
}

function defaultReadDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(publicError('Чтение изображений недоступно в этом браузере.', 'FILE_READER_UNAVAILABLE'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(publicError('Не удалось прочитать изображение.', 'FILE_READ_FAILED'));
    reader.readAsDataURL(file);
  });
}

function base64FromDataUrl(dataUrl) {
  const separator = String(dataUrl || '').indexOf(',');
  if (separator === -1) throw publicError('Не удалось подготовить изображение.', 'INVALID_DATA_URL');
  return dataUrl.slice(separator + 1);
}

function validateImage(file, availableSlots) {
  if (!IMAGE_MIME_TYPES.includes(file?.type)) {
    return publicError('Поддерживаются PNG, JPEG, WebP и GIF.', 'UNSUPPORTED_IMAGE');
  }
  if (!Number.isFinite(file?.size) || file.size < 0 || file.size > MAX_IMAGE_BYTES) {
    return publicError('Размер изображения не должен превышать 8 МиБ.', 'IMAGE_TOO_LARGE');
  }
  if (availableSlots < 1) {
    return publicError('Можно прикрепить не больше четырёх изображений.', 'TOO_MANY_IMAGES');
  }
  return null;
}

export function createAttachmentController({
  api,
  getThreadId,
  readDataUrl = defaultReadDataUrl,
  urlApi = globalThis.URL,
  onChange = () => {},
} = {}) {
  let attachments = [];
  let acquisitionGeneration = 0;
  let acquisitionQueue = Promise.resolve();

  function snapshot() {
    return { attachments: attachments.map((item) => ({ ...item })) };
  }

  function notify() {
    const next = snapshot();
    onChange(next);
    return next;
  }

  function revoke(item) {
    if (!item?.previewUrl) return;
    try { urlApi?.revokeObjectURL?.(item.previewUrl); } catch {}
  }

  function isCurrentAcquisition(threadId, generation) {
    return generation === acquisitionGeneration && getThreadId?.() === threadId;
  }

  function staleCleanupError(file) {
    return {
      file,
      message: 'Не удалось удалить отменённое изображение.',
      code: 'STALE_ATTACHMENT_CLEANUP_FAILED',
    };
  }

  async function cleanupUploaded(threadId, uploaded, previewUrl = '') {
    if (previewUrl) revoke({ previewUrl });
    try {
      await api.deleteAttachment(threadId, uploaded.id);
      return true;
    } catch {
      return false;
    }
  }

  async function acquireFiles(files, threadId, generation) {
    if (!isCurrentAcquisition(threadId, generation)) return { accepted: [], rejected: [] };

    const candidates = [];
    const rejected = [];
    let availableSlots = MAX_ATTACHMENTS - attachments.length;
    for (const file of Array.from(files || [])) {
      const error = validateImage(file, availableSlots);
      if (error) rejected.push({ file, message: error.message, code: error.code });
      else {
        candidates.push(file);
        availableSlots -= 1;
      }
    }

    const accepted = [];
    for (const file of candidates) {
      if (!isCurrentAcquisition(threadId, generation)) break;
      if (attachments.length >= MAX_ATTACHMENTS) {
        const error = validateImage(file, 0);
        rejected.push({ file, message: error.message, code: error.code });
        continue;
      }
      let uploaded = null;
      let previewUrl = '';
      try {
        const dataUrl = await readDataUrl(file);
        if (!isCurrentAcquisition(threadId, generation)) break;
        if (attachments.length >= MAX_ATTACHMENTS) {
          const error = validateImage(file, 0);
          rejected.push({ file, message: error.message, code: error.code });
          continue;
        }
        uploaded = await api.uploadAttachment({
          threadId,
          name: String(file.name || 'image'),
          mime: file.type,
          base64: base64FromDataUrl(dataUrl),
        });
        if (!uploaded?.id) throw publicError('JARVIS не вернул идентификатор изображения.', 'INVALID_RESPONSE');
        if (!isCurrentAcquisition(threadId, generation)) {
          if (!await cleanupUploaded(threadId, uploaded)) rejected.push(staleCleanupError(file));
          break;
        }
        previewUrl = urlApi?.createObjectURL?.(file) || '';
        if (!isCurrentAcquisition(threadId, generation)) {
          if (!await cleanupUploaded(threadId, uploaded, previewUrl)) rejected.push(staleCleanupError(file));
          break;
        }
        const item = {
          id: uploaded.id,
          threadId,
          name: uploaded.name || file.name || 'image',
          mime: uploaded.mime || file.type,
          size: Number.isFinite(uploaded.size) ? uploaded.size : file.size,
          previewUrl,
        };
        attachments.push(item);
        accepted.push({ ...item });
        notify();
      } catch (error) {
        if (uploaded?.id) {
          const cleaned = await cleanupUploaded(threadId, uploaded, previewUrl);
          if (!cleaned) {
            rejected.push(staleCleanupError(file));
            continue;
          }
        }
        rejected.push({ file, message: error?.message || 'Не удалось загрузить изображение.', code: error?.code || 'UPLOAD_FAILED' });
      }
    }
    return { accepted, rejected };
  }

  function acceptFiles(files) {
    const requestedFiles = Array.from(files || []);
    const threadId = getThreadId?.();
    const generation = acquisitionGeneration;
    if (!threadId) {
      return Promise.resolve({ accepted: [], rejected: [{ file: null, message: 'Сначала выберите диалог.', code: 'THREAD_REQUIRED' }] });
    }
    const operation = acquisitionQueue.then(() => acquireFiles(requestedFiles, threadId, generation));
    acquisitionQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function remove(id) {
    const index = attachments.findIndex((item) => item.id === id);
    if (index === -1) return false;
    const [item] = attachments.splice(index, 1);
    revoke(item);
    notify();
    await api.deleteAttachment(item.threadId, item.id);
    return true;
  }

  function commit(ids = attachments.map((item) => item.id)) {
    const committed = new Set(ids);
    for (const item of attachments) {
      if (committed.has(item.id)) revoke(item);
    }
    attachments = attachments.filter((item) => !committed.has(item.id));
    notify();
  }

  async function switchThread(nextThreadId) {
    acquisitionGeneration += 1;
    const stale = attachments;
    attachments = [];
    for (const item of stale) revoke(item);
    notify();
    await Promise.allSettled(stale.map((item) => api.deleteAttachment(item.threadId, item.id)));
    return nextThreadId;
  }

  return Object.freeze({ acceptFiles, commit, getSnapshot: snapshot, remove, switchThread });
}

function defaultBlobToBase64(blob) {
  return defaultReadDataUrl(blob).then(base64FromDataUrl);
}

function supportedRecorderMime(MediaRecorderImpl) {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorderImpl?.isTypeSupported !== 'function') return '';
  return candidates.find((mime) => MediaRecorderImpl.isTypeSupported(mime)) || '';
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch {}
  }
}

export function createVoiceController({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder,
  transcribe = async () => ({ text: '' }),
  blobToBase64 = defaultBlobToBase64,
  getSelection = () => ({ value: '', selectionStart: 0, selectionEnd: 0 }),
  insertTranscript = () => {},
  onStateChange = () => {},
  clock = () => Date.now(),
  setIntervalImpl = globalThis.setInterval?.bind(globalThis),
  clearIntervalImpl = globalThis.clearInterval?.bind(globalThis),
} = {}) {
  let state = { mode: 'idle', elapsedMs: 0, message: '' };
  let recorder = null;
  let stream = null;
  let chunks = [];
  let timer = null;
  let startedAt = 0;
  let cancelled = false;

  function transition(mode, patch = {}) {
    state = { mode, elapsedMs: mode === 'recording' ? state.elapsedMs : 0, message: '', ...patch };
    onStateChange({ ...state });
    return state;
  }

  function stopTimer() {
    if (timer != null) clearIntervalImpl?.(timer);
    timer = null;
  }

  function releaseStream() {
    stopTracks(stream);
    stream = null;
  }

  async function start() {
    if (state.mode !== 'idle') return false;
    if (typeof mediaDevices?.getUserMedia !== 'function' || typeof MediaRecorderImpl !== 'function') {
      transition('idle', { message: 'Запись голоса не поддерживается браузером.', error: true });
      return false;
    }
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
      const mimeType = supportedRecorderMime(MediaRecorderImpl);
      recorder = mimeType ? new MediaRecorderImpl(stream, { mimeType }) : new MediaRecorderImpl(stream);
      chunks = [];
      cancelled = false;
      recorder.ondataavailable = ({ data }) => { if (data?.size > 0) chunks.push(data); };
      recorder.start();
      startedAt = clock();
      transition('recording', { elapsedMs: 0 });
      timer = setIntervalImpl?.(() => {
        state = { ...state, elapsedMs: Math.max(0, clock() - startedAt) };
        onStateChange({ ...state });
      }, 250);
      timer?.unref?.();
      return true;
    } catch {
      releaseStream();
      recorder = null;
      transition('idle', { message: 'Нет доступа к микрофону.', error: true });
      return false;
    }
  }

  function stopRecorder() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') { resolve(); return; }
      const previousStop = recorder.onstop;
      recorder.onstop = (event) => { previousStop?.(event); resolve(); };
      recorder.stop();
    });
  }

  async function cancel() {
    if (state.mode !== 'recording') return false;
    cancelled = true;
    stopTimer();
    await stopRecorder();
    releaseStream();
    chunks = [];
    recorder = null;
    transition('idle', { message: 'Запись отменена.' });
    return true;
  }

  async function check() {
    if (state.mode !== 'recording') return false;
    stopTimer();
    transition('transcribing', { message: 'Распознаю запись…' });
    try {
      await stopRecorder();
      releaseStream();
      if (cancelled) return false;
      const mime = recorder?.mimeType || chunks[0]?.type || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      const base64 = await blobToBase64(blob);
      const result = await transcribe({ mime, base64 });
      const transcript = String(result?.text || '').trim();
      if (!transcript) throw publicError('Речь не распознана.', 'EMPTY_TRANSCRIPT');
      const selection = getSelection();
      insertTranscript(insertAtSelection(
        selection.value,
        selection.selectionStart,
        selection.selectionEnd,
        transcript,
      ));
      chunks = [];
      recorder = null;
      transition('idle', { message: 'Текст добавлен в сообщение.' });
      return result;
    } catch (error) {
      releaseStream();
      chunks = [];
      recorder = null;
      transition('idle', { message: error?.message || 'Не удалось распознать запись.', error: true });
      return false;
    }
  }

  function setSending(sending) {
    if (sending && state.mode === 'idle') transition('sending', { message: 'Отправляю…' });
    else if (!sending && state.mode === 'sending') transition('idle');
  }

  return Object.freeze({ cancel, check, getState: () => ({ ...state }), setSending, start });
}
