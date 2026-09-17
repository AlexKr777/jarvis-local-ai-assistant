export const CRYPTO_MODES = Object.freeze(['OFF', 'DRY_RUN', 'AUTO']);

export function cryptoStatusLabel(status = {}) {
  if (status.recovery?.status === 'blocked') return 'Recovery blocked';
  if (status.binanceStatus?.state === 'reconnecting' || status.scannerStatus?.state === 'reconnecting') return 'Binance reconnecting';
  if (status.scannerStatus?.state === 'degraded') return 'Scanner degraded';
  if (status.scanner !== 'running') return 'Scanner paused';
  if ((status.pendingCandidates || 0) > 0) return `${status.pendingCandidates} pending`;
  if (status.mode === 'OFF') return 'Monitoring only';
  if (status.mode === 'AUTO') {
    const cap = Number(status.maxPosts24h || 10);
    const count = Number(status.posts24h || 0);
    return `AUTO: ${status.autoArmed ? 'ON' : 'OFF'} · ${count}/${cap}`;
  }
  return status.autoReady ? 'Dry run verified' : 'Dry run';
}

export function cryptoActivityLabel(event = {}) {
  const entry = cryptoTimelineEntry(event);
  return [entry.title, entry.detail].filter(Boolean).join(' · ');
}

export function cryptoTimelineEntry(event = {}) {
  const payload = event.payload || {};
  const eventType = event.eventType || event.type || 'update';
  const symbol = String(payload.symbol || '').replace(/USDT(?:_PERP)?$/i, '') || 'рынок';
  const posts = Number(payload.posts24h);
  const cap = Number(payload.maxPosts24h || 10);
  const counter = Number.isFinite(posts) ? `Пост ${posts}/${cap} за последние 24ч.` : '';
  const reasonMap = {
    NO_CANDIDATE_WITH_EDITORIAL_MERIT: 'Пост получился недостаточно сильным.',
    MARKET_STORY_DUPLICATE: 'Похожая история недавно уже публиковалась.',
    FEED_DUPLICATE: 'Похожая история недавно уже публиковалась.',
    FACTUAL_VALIDATION_FAILED: 'Не удалось подтвердить данные поста.',
    CHART_STORY_MISMATCH: 'График не совпал с историей поста.',
    CAP_REACHED: 'Достигнут лимит 10/10.',
  };
  const rejected = reasonMap[payload.reason] || reasonMap[payload.errors?.[0]] || 'Пост не прошёл проверку.';
  const labels = {
    anomaly_detected: [`🔥 Найдено событие — ${symbol}`, ''],
    candidate_selected: [`🧠 Анализ — ${symbol}`, 'Ищу лучший угол для поста.'],
    writer_started: [`✍️ Gemma пишет — ${symbol}`, 'Готовлю пост по проверенным фактам.'],
    writer_completed: [`📝 Пост готов — ${symbol}`, ''],
    writer_unavailable: ['⚠️ Local Writer unavailable', 'Gemma/Ollama is not running.'],
    codex_started: [`🧠 Анализ — ${symbol}`, 'Готовлю пост.'],
    codex_completed: [`✍️ Черновик готов — ${symbol}`, ''],
    candidate_rejected: [`⏭ Пропущено — ${symbol}`, rejected],
    content_rejected: [`⏭ Пропущено — ${symbol}`, rejected],
    post_preview_ready: [`✍️ Пост готов — ${symbol}`, payload.postText || 'Пост прошёл проверки.'],
    publish_completed: [`✅ Опубликовано — ${symbol}`, counter],
    publication_result: [payload.published ? `✅ Опубликовано — ${symbol}` : `⚠️ Публикация не завершена — ${symbol}`, payload.postText || counter],
    mode_changed: [payload.mode === 'AUTO' ? '🟢 AUTO включён' : '🔴 AUTO выключен', `Лимит: ${Number(payload.posts24h || 0)}/${cap}`],
    post_limit_reset: ['🔄 Лимит публикаций обновлён', `Лимит: 0/${cap}`],
    binance_rest_state_changed: ['⚠️ Binance cooldown', 'REST-анализ временно остановлен.'],
  };
  const [title, detail] = labels[eventType] || ['Crypto update', ''];
  const date = new Date(event.occurredAt);
  const time = Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return { time, title, detail, technical: payload };
}

export function cryptoMessageView(value) {
  const text = String(value || '');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { kind: 'answer', text }; }
  if (parsed?.decision === 'publish' && typeof parsed.postText === 'string') {
    return {
      kind: 'publish',
      text: parsed.postText,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      preset: typeof parsed.visualIntent?.preset === 'string' ? parsed.visualIntent.preset : '',
    };
  }
  if (parsed?.decision === 'skip') {
    return {
      kind: 'skip',
      text: 'Пост пропущен.',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      preset: '',
    };
  }
  return { kind: 'technical', text: '', technical: parsed };
}

export function publicCryptoMessage(value) {
  return cryptoMessageView(value).text;
}

const MEANINGFUL_TYPES = new Set([
  'scanner_started', 'scanner_stopped', 'anomaly_detected', 'candidate_selected', 'candidate_rejected', 'writer_started', 'writer_completed', 'writer_unavailable', 'codex_started', 'codex_completed',
  'content_rejected', 'candidate_queued', 'candidate_dequeued', 'post_preview_ready', 'publish_intent',
  'publish_completed', 'publish_failed', 'publish_unknown', 'publication_result', 'mode_changed',
  'runtime_error', 'recovery_blocked',
  'storage_corruption_detected', 'binance_rest_state_changed',
]);

export function meaningfulCryptoEvents(events, limit = 40) {
  const seen = new Set();
  return (Array.isArray(events) ? events : []).filter((event) => {
    const eventType = event?.eventType || event?.type;
    if (!MEANINGFUL_TYPES.has(eventType)) return false;
    const key = event.eventId || `${eventType}:${event.occurredAt}:${event.payload?.candidateId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-limit);
}
