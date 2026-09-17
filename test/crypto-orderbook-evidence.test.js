import test from 'node:test';
import assert from 'node:assert/strict';

import { OrderBookEvidenceSampler } from '../src/crypto/market/orderbook-evidence.js';

test('order-book evidence never promotes a single snapshot into a stable cluster', () => {
  const sampler = new OrderBookEvidenceSampler({ minimumObservations: 3 });
  const first = sampler.record({ symbol: 'TESTUSDT', currentPrice: 100, snapshot: { bids: [['99.8', '500']], asks: [['100.2', '500']] }, observedAt: 1 });
  assert.deepEqual(first, []);
});

test('order-book evidence only returns persistent sampled clusters and retains their side', () => {
  const sampler = new OrderBookEvidenceSampler({ minimumObservations: 3 });
  for (let observedAt = 1; observedAt <= 3; observedAt += 1) {
    sampler.record({
      symbol: 'TESTUSDT', currentPrice: 100,
      snapshot: { bids: [['99.8', '500'], ['99.1', '12']], asks: [['100.2', '450']] }, observedAt,
    });
  }
  const clusters = sampler.stableClusters('TESTUSDT', 100);
  assert.ok(clusters.length >= 2);
  assert.ok(clusters.every((cluster) => cluster.observations >= 3));
  assert.ok(clusters.some((cluster) => cluster.side === 'bid'));
  assert.ok(clusters.every((cluster) => cluster.persistence === 1));
});
