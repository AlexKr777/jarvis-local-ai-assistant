import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptedHistoryEntry,
  classifyEvaluationOutcome,
  rebuildAcceptedHistory,
  summarizeProviderCalls,
} from '../src/crypto/evaluation/feed-evaluation.js';

test('feed evaluation classifies a provider 502 as PROVIDER_FAILED without accepting the pre-critic draft', () => {
  const result = classifyEvaluationOutcome({
    result: null,
    error: { code: 'ANYMODEL_TRANSIENT_ERROR', message: 'AnyModel request failed with HTTP 502.' },
    calls: [{ stage: 'critic', status: 'error', code: 'ANYMODEL_TRANSIENT_ERROR', attempts: 2 }],
  });

  assert.equal(result.terminalState, 'PROVIDER_FAILED');
  assert.equal(result.accepted, false);
  assert.equal(result.retryableOnResume, true);
  assert.equal(result.providerStats.http502, 1);
});

test('feed evaluation treats a second provider timeout as TIMEOUT and keeps it eligible for one later resume', () => {
  const result = classifyEvaluationOutcome({
    result: null,
    error: { code: 'ANYMODEL_TIMEOUT', message: 'AnyModel request was unavailable.' },
    calls: [{ stage: 'writer_candidates', status: 'error', code: 'ANYMODEL_TIMEOUT', attempts: 2 }],
  });

  assert.equal(result.terminalState, 'TIMEOUT');
  assert.equal(result.retryableOnResume, true);
  assert.equal(result.providerStats.timeouts, 1);
});

test('feed evaluation records an absent or malformed provider completion as retryable PROVIDER_FAILED', () => {
  const result = classifyEvaluationOutcome({
    result: null,
    error: { code: 'ANYMODEL_INVALID_RESPONSE', message: 'AnyModel response did not match a supported chat completion text shape.' },
    calls: [{ stage: 'writer_reflection', status: 'error', code: 'ANYMODEL_INVALID_RESPONSE', attempts: 1 }],
  });

  assert.equal(result.terminalState, 'PROVIDER_FAILED');
  assert.equal(result.retryableOnResume, true);
});

test('feed evaluation keeps deterministic writer skips out of the feed history', () => {
  const result = classifyEvaluationOutcome({ result: { status: 'skip', reason: 'WRITER_CONTRACT_INVALID' }, calls: [] });
  assert.equal(result.terminalState, 'EDITORIAL_REJECTED');
  assert.equal(result.accepted, false);
  assert.equal(result.retryableOnResume, false);
});

test('feed evaluation restores history from accepted checkpoints only and preserves prior thesis by sequence', () => {
  const checkpoints = [
    { feedPosition: 1, terminalState: 'ACCEPTED', symbol: 'BULLAUSDT', finalPost: 'first', narrativeSignature: { openingMode: 'observation' }, publishedThesis: { centralThesis: 'first' }, createdAt: '2026-09-17T00:00:00.000Z' },
    { feedPosition: 2, terminalState: 'PROVIDER_FAILED', symbol: 'OTHERUSDT', finalPost: 'must not enter history' },
    { feedPosition: 3, terminalState: 'ACCEPTED', symbol: 'BULLAUSDT', finalPost: 'second', narrativeSignature: { openingMode: 'contrast' }, publishedThesis: { centralThesis: 'second' }, createdAt: '2026-09-17T00:01:00.000Z' },
  ];

  const history = rebuildAcceptedHistory(checkpoints);
  assert.deepEqual(history.map((item) => item.text), ['first', 'second']);
  assert.deepEqual(acceptedHistoryEntry(checkpoints[2]).publishedThesis, { centralThesis: 'second' });
});

test('feed evaluation aggregates retry attempts and stage failure counts without secrets', () => {
  const summary = summarizeProviderCalls([
    { stage: 'critic', status: 'error', code: 'ANYMODEL_TRANSIENT_ERROR', attempts: 2, diagnosticPath: 'safe.json' },
    { stage: 'writer_candidates', status: 'ok', attempts: 1 },
    { stage: 'analyst_brain', status: 'error', code: 'ANYMODEL_TIMEOUT', attempts: 2 },
  ]);

  assert.equal(summary.totalCalls, 3);
  assert.equal(summary.retryCount, 2);
  assert.equal(summary.stageFailures.critic, 1);
  assert.equal(summary.stageFailures.analyst_brain, 1);
  assert.equal(summary.timeouts, 1);
  assert.doesNotMatch(JSON.stringify(summary), /Authorization|Bearer/i);
});
