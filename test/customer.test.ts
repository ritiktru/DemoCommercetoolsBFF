import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CommercetoolsClient } from '../src/commercetools.js';

const config = loadConfig({
  CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'test-client', CT_CLIENT_SECRET: 'fake-test-secret',
  CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com',
  CT_SCOPES: 'manage_customers:test-project',
});
const customer = { id: 'customer-1', version: 1, email: 'person@example.com', authenticationMode: 'ExternalAuth', isEmailVerified: false, createdAt: '2026-09-16T00:00:00Z' };

test('accepts customer or project management scope only for the configured project', () => {
  for (const scope of ['manage_customers:test-project', 'manage_project:test-project']) {
    assert.equal(loadConfig({ ...config, PORT: String(config.PORT), CT_SCOPES: scope }).CT_SCOPES, scope);
  }
  for (const scope of ['view_customers:test-project', 'manage_project:other-project']) {
    assert.throws(() => loadConfig({ ...config, PORT: String(config.PORT), CT_SCOPES: scope }), /CT_SCOPES/);
  }
});

async function withApp(fetcher: typeof fetch, run: (base: string) => Promise<void>) {
  const app = await createApp(new CommercetoolsClient(config, fetcher));
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await app.close(); }
}
const post = (base: string, body: unknown) => fetch(`${base}/api/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('creates ExternalAuth customer without password and caches OAuth token', async () => {
  let tokenCalls = 0;
  let customerCalls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) {
      tokenCalls++;
      assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from('test-client:fake-test-secret').toString('base64')}`);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), { grant_type: 'client_credentials', scope: 'manage_customers:test-project' });
      return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    }
    customerCalls++;
    assert.equal(String(url), 'https://api.example.com/test-project/customers');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-token');
    assert.deepEqual(JSON.parse(String(init?.body)), { email: customer.email, authenticationMode: 'ExternalAuth' });
    return Response.json({ customer: { ...customer, password: 'must-be-stripped' } }, { status: 201 });
  };
  await withApp(fetcher, async base => {
    for (let i = 0; i < 2; i++) {
      const response = await post(base, { email: customer.email });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { customer });
    }
  });
  assert.equal(tokenCalls, 1);
  assert.equal(customerCalls, 2);
});

test('rejects invalid email, passwords, identity IDs and verification flags before upstream call', async () => {
  await withApp(async () => { throw new Error('Upstream must not be called'); }, async base => {
    for (const body of [{ email: 'invalid' }, {}, { email: customer.email, password: 'x' }, { email: customer.email, externalId: 'x' }, { email: customer.email, isEmailVerified: true }]) {
      assert.equal((await post(base, body)).status, 400);
    }
    const malformed = await fetch(`${base}/api/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await fetch(`${base}/api/customers`, { method: 'POST', body: 'hello' })).status, 415);
  });
});

for (const [upstreamStatus, expectedStatus] of [[409, 409], [403, 502], [429, 503], [500, 502]]) {
  test(`maps upstream ${upstreamStatus} safely`, async () => {
    await withApp(async url => String(url).endsWith('/oauth/token')
      ? Response.json({ access_token: 'fake-token', expires_in: 3600 })
      : Response.json({ message: 'sensitive upstream details' }, { status: upstreamStatus }), async base => {
      const response = await post(base, { email: customer.email });
      assert.equal(response.status, expectedStatus);
      assert.ok(!(await response.text()).includes('sensitive'));
    });
  });
}

test('OAuth failure is sanitized', async () => {
  await withApp(async () => Response.json({ message: 'fake-test-secret' }, { status: 401 }), async base => {
    const response = await post(base, { email: customer.email });
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('fake-test-secret'));
  });
});

test('configuration errors expose field names only', () => {
  assert.throws(() => loadConfig({ CT_CLIENT_SECRET: 'private-value' }), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('CT_PROJECT_KEY'));
    assert.ok(!error.message.includes('private-value'));
    return true;
  });
});

test('login falls back to the customer Store when global sign-in rejects a Store-scoped customer', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async url => {
    const path = new URL(String(url)).pathname; urls.push(path);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path.endsWith('/oauth/token')) return json(200, { access_token: 't', expires_in: 3600, token_type: 'Bearer' });
    if (path === '/test-project/login') return json(400, { statusCode: 400, errors: [{ code: 'InvalidCredentials', message: 'x' }] });
    if (path === '/test-project/customers') return json(200, { results: [{ stores: [{ typeId: 'store', key: 'store-1' }] }] });
    if (path === '/test-project/in-store/key=store-1/login') return json(200, { customer: { ...customer, authenticationMode: 'Password' } });
    return json(500, {});
  };
  const result = await new CommercetoolsClient(config, fetcher).loginCustomer('Person@Example.com', 'Passw0rd!x');
  assert.equal(result.customer.id, 'customer-1');
  assert.ok(urls.includes('/test-project/in-store/key=store-1/login'));
});
