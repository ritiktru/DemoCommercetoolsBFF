import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRewardPoints } from '../src/rewards/rewards-client.js';

test('rewards combine eligible SKUs and support one-time and repeating rules', () => {
  const result = calculateRewardPoints([
    { key: 'buy-three', name: 'Buy 3', eligibleSkus: ['A', 'B'], requiredQuantity: 3, points: 200, repeat: false, active: true },
    { key: 'each-two', name: 'Each 2', eligibleSkus: ['A'], requiredQuantity: 2, points: 50, repeat: true, active: true },
    { key: 'inactive', name: 'Inactive', eligibleSkus: ['B'], requiredQuantity: 1, points: 999, repeat: true, active: false },
  ], [{ sku: 'A', quantity: 4 }, { sku: 'B', quantity: 1 }, { sku: 'C', quantity: 20 }]);
  assert.equal(result.points, 300);
  assert.deepEqual(result.awardedRules, [
    { key: 'buy-three', occurrences: 1, points: 200 },
    { key: 'each-two', occurrences: 2, points: 100 },
  ]);
});
