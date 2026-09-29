import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { CommercetoolsClient } from '../src/commercetools.js';
import type { GoogleIdentity } from '../src/google.js';

const config = loadConfig({ CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'test-client', CT_CLIENT_SECRET: 'fake-secret', CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com', CT_SCOPES: 'manage_project:test-project' });
const identity: GoogleIdentity = { subject: 'subject-1', email: 'person@gmail.com', authoritativeEmail: true };
const key = `google-${createHash('sha256').update(identity.subject).digest('hex')}`;
const customer = { id: 'customer-1', version: 1, email: identity.email, authenticationMode: 'ExternalAuth', isEmailVerified: true, createdAt: '2026-09-16T00:00:00Z' };
function client(handler: typeof fetch) {
  return new CommercetoolsClient(config, async (url, init) => String(url).endsWith('/oauth/token')
    ? Response.json({ access_token: 'fake-token', expires_in: 3600 }) : handler(url, init));
}

test('first Google login creates verified ExternalAuth customer with stable identity key', async () => {
  let queries = 0;
  const ct = client(async (url, init) => {
    if (init?.method !== 'POST') {
      queries++;
      const where = new URL(String(url)).searchParams.get('where');
      assert.equal(where, queries === 1 ? `key=${JSON.stringify(key)}` : `email=${JSON.stringify(identity.email)}`);
      return Response.json({ results: [] });
    }
    assert.deepEqual(JSON.parse(String(init.body)), { email: identity.email, authenticationMode: 'ExternalAuth', key, isEmailVerified: true });
    return Response.json({ customer: { ...customer, key } }, { status: 201 });
  });
  assert.equal((await ct.resolveGoogleCustomer(identity)).customer.key, key);
  assert.equal(queries, 2);
});

test('returning Google user resolves by subject even when email changes', async () => {
  let queries = 0;
  const ct = client(async (url, init) => {
    queries++;
    assert.equal(new URL(String(url)).searchParams.get('where'), `key=${JSON.stringify(key)}`);
    assert.notEqual(init?.method, 'POST');
    return Response.json({ results: [{ ...customer, key }] });
  });
  assert.equal((await ct.resolveGoogleCustomer({ ...identity, email: 'new@gmail.com' })).customer.id, customer.id);
  assert.equal(queries, 1);
});

test('links existing unbound ExternalAuth customer with optimistic version', async () => {
  let queries = 0;
  const ct = client(async (url, init) => {
    if (init?.method !== 'POST') return Response.json({ results: ++queries === 1 ? [] : [{ ...customer, isEmailVerified: false }] });
    assert.ok(String(url).endsWith(`/customers/${customer.id}`));
    assert.deepEqual(JSON.parse(String(init.body)), { version: 1, actions: [{ action: 'setKey', key }] });
    return Response.json({ ...customer, key });
  });
  assert.equal((await ct.resolveGoogleCustomer(identity)).customer.id, customer.id);
});

for (const existing of [{ ...customer, key: 'different-google-user' }, { ...customer, authenticationMode: 'Password' }]) {
  test(`refuses linking existing ${existing.authenticationMode} customer with key ${'key' in existing ? existing.key : 'none'}`, async () => {
    let queries = 0;
    const ct = client(async (_url, init) => {
      assert.notEqual(init?.method, 'POST');
      return Response.json({ results: ++queries === 1 ? [] : [existing] });
    });
    await assert.rejects(ct.resolveGoogleCustomer(identity), { status: 409 });
  });
}

test('unbound non-Google-hosted email needs additional verification', async () => {
  const ct = client(async () => Response.json({ results: [] }));
  await assert.rejects(ct.resolveGoogleCustomer({ ...identity, email: 'person@example.com', authoritativeEmail: false }), { status: 403 });
});

test('concurrent creation conflict resolves only the same Google identity', async () => {
  let queries = 0;
  const ct = client(async (_url, init) => {
    if (init?.method === 'POST') return Response.json({}, { status: 409 });
    return Response.json({ results: ++queries === 3 ? [{ ...customer, key }] : [] });
  });
  assert.equal((await ct.resolveGoogleCustomer(identity)).customer.id, customer.id);
});
