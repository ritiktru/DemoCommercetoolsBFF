import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CommercetoolsClient } from '../src/commercetools.js';
import type { CartService } from '../src/carts/cart.js';

const config = loadConfig({ CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'test-client', CT_CLIENT_SECRET: 'fake-secret', CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com', CT_SCOPES: 'manage_project:test-project' });
const origin = 'http://localhost:3000';
const owner = { id: 'customer-1', email: 'person@gmail.com' };
const cart = {
  id: 'a6e7dbb9-8397-4ee2-945b-8d9cda32b05e', version: 1,
  customerId: owner.id, customerEmail: owner.email, cartState: 'Active',
  totalPrice: { currencyCode: 'EUR', centAmount: 0, fractionDigits: 2 }, lineItems: [],
  createdAt: '2026-09-16T00:00:00Z', lastModifiedAt: '2026-09-16T00:00:00Z',
};
function commerce(handler: typeof fetch, scopes = config.CT_SCOPES) {
  return new CommercetoolsClient({ ...config, CT_SCOPES: scopes }, async (url, init) => String(url).endsWith('/oauth/token')
    ? Response.json({ access_token: 'fake-token', expires_in: 3600 }) : handler(url, init));
}
async function withApp(carts: CartService, run: (base: string, cookie: string) => Promise<void>) {
  const app = await createApp({ createCustomer: async () => { throw new Error('Unexpected customer signup'); } }, {
    clientId: 'fake.apps.googleusercontent.com', origin,
    verifier: { verify: async () => ({ subject: 'google-1', email: owner.email, authoritativeEmail: true }) },
    customers: { resolveGoogleCustomer: async () => ({ customer: { ...owner, version: 1, authenticationMode: 'ExternalAuth', isEmailVerified: true, createdAt: cart.createdAt } }) },
  }, carts);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  try {
    const challenge = await fetch(`${base}/api/auth/google/challenge`);
    const login = await fetch(`${base}/api/auth/google`, {
      method: 'POST', headers: { Origin: origin, Cookie: challenge.headers.getSetCookie()[0]!.split(';')[0]!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'fake-token' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('bff_session='))!.split(';')[0]!;
    await run(base, cookie);
  } finally { await app.close(); }
}
const post = (base: string, cookie: string, input: unknown, requestOrigin = origin) => fetch(`${base}/api/carts`, {
  method: 'POST', headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
});

test('authenticated cart creation calls commercetools with session owner and can fetch saved cart', async () => {
  let calls = 0;
  const ct = commerce(async (url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-token');
    if (init?.method === 'POST') {
      assert.equal(String(url).split('?')[0], 'https://api.example.com/test-project/carts');
      assert.deepEqual(JSON.parse(String(init.body)), { currency: 'EUR', country: 'DE', customerId: owner.id, customerEmail: owner.email });
      return Response.json({ ...cart, country: 'DE', sensitiveInternalField: 'must-be-stripped' }, { status: 201 });
    }
    assert.equal(String(url).split('?')[0], `https://api.example.com/test-project/carts/${cart.id}`);
    return Response.json({ ...cart, country: 'DE' });
  });
  await withApp(ct, async (base, cookie) => {
    const created = await post(base, cookie, { currency: 'EUR', country: 'DE' });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { cart: { ...cart, country: 'DE' } });
    const fetched = await fetch(`${base}/api/carts/${cart.id}`, { headers: { Cookie: cookie } });
    assert.equal(fetched.status, 200);
    assert.deepEqual(await fetched.json(), { cart: { ...cart, country: 'DE' } });
  });
  assert.equal(calls, 2);
});

test('rejects missing session, cross-origin writes, invalid codes and caller-supplied ownership', async () => {
  const ct = commerce(async () => { throw new Error('No commerce call allowed'); });
  await withApp(ct, async (base, cookie) => {
    assert.equal((await post(base, '', { currency: 'EUR' })).status, 401);
    assert.equal((await post(base, cookie, { currency: 'EUR' }, 'https://attacker.example')).status, 403);
    for (const input of [{}, { currency: 'eur' }, { currency: 'EUR', country: 'Germany' }, { currency: 'EUR', customerId: 'other-customer' }, { currency: 'EUR', customerEmail: 'other@example.com' }, { currency: 'EUR', anonymousId: 'guest' }]) {
      assert.equal((await post(base, cookie, input)).status, 400);
    }
    assert.equal((await fetch(`${base}/api/carts`, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: 'text' })).status, 415);
    assert.equal((await fetch(`${base}/api/carts/not-a-uuid`, { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(`${base}/api/carts/${cart.id}`)).status, 401);
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    assert.equal((await post(base, cookie, { currency: 'EUR' })).status, 401);
  });
});

for (const customerId of ['other-customer', undefined]) {
  test(`cannot read cart with owner ${customerId ?? 'anonymous'}`, async () => {
    await withApp(commerce(async () => Response.json({ ...cart, customerId })), async (base, cookie) => {
      const response = await fetch(`${base}/api/carts/${cart.id}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 404);
      assert.ok(!(await response.text()).includes(owner.email));
    });
  });
}

for (const [upstreamStatus, expectedStatus] of [[400, 400], [403, 502], [404, 404], [429, 503], [500, 502]]) {
  test(`cart creation maps upstream ${upstreamStatus} safely`, async () => {
    await withApp(commerce(async () => Response.json({ message: 'sensitive upstream details' }, { status: upstreamStatus })), async (base, cookie) => {
      const response = await post(base, cookie, { currency: 'EUR' });
      assert.equal(response.status, expectedStatus);
      assert.ok(!(await response.text()).includes('sensitive'));
    });
  });
}

test('missing cart management scope fails before calling commercetools', async () => {
  await assert.rejects(commerce(async () => { throw new Error('No request expected'); }, 'manage_customers:test-project').createCart({ currency: 'EUR' }, owner), { status: 503, code: 'CartScopeMissing' });
});

test('unexpected owner in created cart is not returned', async () => {
  await assert.rejects(commerce(async () => Response.json({ ...cart, customerId: 'other-customer' })).createCart({ currency: 'EUR' }, owner), { status: 502 });
});
