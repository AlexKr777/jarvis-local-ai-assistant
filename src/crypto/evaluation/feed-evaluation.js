function compact(value, maximum = 600) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function isTimeout(error, calls) {
  return error?.code === 'ANYMODEL_TIMEOUT' || calls.some((call) => call?.code === 'ANYMODEL_TIMEOUT');
}

function statusFromError(error) {
  const match = compact(error?.message).match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function isProviderFailure(error, calls) {
  const codes = [error?.code, ...calls.map((call) => call?.code)].filter(Boolean).map(String);
  return codes.some((code) => /^(?:ANYMODEL_(?:TRANSIENT_ERROR|UNAVAILABLE|TIMEOUT|INVALID_RESPONSE)|ECONN(?:RESET|REFUSED)|ETIMEDOUT|ENOTFOUND)$/.test(code))
    || [429, 502, 503, 504].includes(statusFromError(error));
}

function terminalForReady(result) {
  return result?.status === 'ready' && result?.content?.postText ? 'ACCEPTED' : null;
}

export function summarizeProviderCalls(calls = [], error = null) {
  const safeCalls = Array.isArray(calls) ? calls : [];
  const statuses = safeCalls.map((call) => statusFromError(call)).filter(Number.isFinite);
  const errorStatus = statusFromError(error);
  if (Number.isFinite(errorStatus)) statuses.push(errorStatus);
  const stageFailures = {};
  for (const call of safeCalls.filter((call) => call?.status === 'error')) {
    const stage = compact(call.stage, 80) || 'unknown';
    stageFailures[stage] = (stageFailures[stage] || 0) + 1;
  }
  const retryCount = safeCalls.reduce((total, call) => total + Math.max(0, Number(call?.attempts || 1) - 1), 0);
  return Object.freeze({
    totalCalls: safeCalls.length,
    retryCount,
    http429: statuses.filter((status) => status === 429).length,
    http502: statuses.filter((status) => status === 502).length,
    other5xx: statuses.filter((status) => status >= 500 && status !== 502).length,
    timeouts: safeCalls.some((call) => call?.code === 'ANYMODEL_TIMEOUT') || error?.code === 'ANYMODEL_TIMEOUT' ? 1 : 0,
    stageFailures,
  });
}

export function classifyEvaluationOutcome({ result = null, error = null, calls = [] } = {}) {
  const accepted = terminalForReady(result) === 'ACCEPTED';
  let terminalState = accepted ? 'ACCEPTED' : null;
  if (!terminalState && isTimeout(error, calls)) terminalState = 'TIMEOUT';
  if (!terminalState && isProviderFailure(error, calls)) terminalState = 'PROVIDER_FAILED';
  if (!terminalState && result?.status === 'skip') terminalState = 'EDITORIAL_REJECTED';
  if (!terminalState && result?.status === 'content_rejected') terminalState = 'FACTUAL_REJECTED';
  if (!terminalState) terminalState = 'INTERNAL_ERROR';
  return Object.freeze({
    terminalState,
    accepted,
    retryableOnResume: terminalState === 'PROVIDER_FAILED' || terminalState === 'TIMEOUT',
    providerStats: summarizeProviderCalls(calls, error),
  });
}

export function acceptedHistoryEntry(checkpoint = {}) {
  if (checkpoint?.terminalState !== 'ACCEPTED' || !checkpoint.finalPost || !checkpoint.symbol) return null;
  return Object.freeze({
    source: 'v5_feed_evaluation',
    symbol: checkpoint.symbol,
    text: checkpoint.finalPost,
    fingerprint: checkpoint.fingerprint || null,
    marketStoryCluster: checkpoint.marketStoryCluster || null,
    hookFamily: checkpoint.hookFamily || null,
    openingFingerprint: checkpoint.narrativeSignature?.openingMode || null,
    narrativeSignature: checkpoint.narrativeSignature || null,
    publishedThesis: checkpoint.publishedThesis || null,
    createdAt: checkpoint.createdAt || null,
  });
}

export function rebuildAcceptedHistory(checkpoints = []) {
  return (Array.isArray(checkpoints) ? checkpoints : [])
    .filter((item) => item?.terminalState === 'ACCEPTED')
    .sort((left, right) => Number(left.feedPosition || 0) - Number(right.feedPosition || 0))
    .map(acceptedHistoryEntry)
    .filter(Boolean);
}
