import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/sessions.js';

const customer = { id: 'customer-1', email: 'person@example.com' };

test('sessions are random, isolated, expire and can be revoked', () => {
  let now = 0;
  const sessions = new SessionStore(1000, 10, () => now);
  const first = sessions.issue(customer);
  const second = sessions.issue({ ...customer, id: 'customer-2' });
  assert.notEqual(first.token, second.token);
  assert.deepEqual(sessions.get(first.token), customer);
  assert.equal(sessions.get(second.token)?.id, 'customer-2');
  assert.equal(sessions.get('unknown'), undefined);
  assert.equal(sessions.get(`${first.token.slice(0, -1)}!`), undefined);
  sessions.revoke(first.token);
  assert.equal(sessions.get(first.token), undefined);
  now = 1000;
  assert.equal(sessions.get(second.token), undefined);
});

test('session data cannot be modified by a caller and expired sessions free capacity', () => {
  let now = 0;
  const sessions = new SessionStore(1000, 1, () => now);
  const input = { ...customer };
  const first = sessions.issue(input);
  input.id = 'changed';
  const result = sessions.get(first.token)!;
  result.id = 'changed-again';
  assert.equal(sessions.get(first.token)?.id, customer.id);
  assert.throws(() => sessions.issue(customer), /capacity/);
  now = 1000;
  assert.ok(sessions.issue(customer).token);
});
