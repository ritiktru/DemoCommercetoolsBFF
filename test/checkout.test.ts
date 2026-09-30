import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommercetoolsClient, CommerceError } from '../src/commercetools.js';
import { loadConfig } from '../src/config.js';

const cartId = 'a6e7dbb9-8397-4ee2-945b-8d9cda32b05e';
const methodId = '9430af3b-547e-4be4-8a6a-765c8011add0';
const storeKey = 'sobeys-0870';
const customer = { id: 'customer-1', email: 'person@example.com' };
const config = loadConfig({
  CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'test-client', CT_CLIENT_SECRET: 'fake-secret',
  CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com',
  CT_SCOPES: 'manage_project:test-project',
  CT_CHECKOUT_SESSION_URL: 'https://session.example.com',
  CT_CHECKOUT_APPLICATION_KEY: 'payment-only-test',
});

test('Payment Only session requires address and shipping, then uses the prepared cart', async () => {
  let cart = {
    id: cartId, version: 1, customerId: customer.id, customerEmail: customer.email,
    store: { typeId: 'store', key: storeKey }, cartState: 'Active', country: 'CA',
    totalPrice: { currencyCode: 'CAD', centAmount: 3999, fractionDigits: 2 },
    lineItems: [{ id: 'item-1', productId: 'product-1', quantity: 1, name: { 'en-CA': 'Test' }, variant: { id: 1, sku: 'test-EA' }, totalPrice: { currencyCode: 'CAD', centAmount: 3999, fractionDigits: 2 } }],
    createdAt: '2026-09-25T00:00:00Z', lastModifiedAt: '2026-09-25T00:00:00Z',
    shippingAddress: undefined as object | undefined, billingAddress: undefined as object | undefined,
    shippingInfo: undefined as object | undefined,
  };
  let sessions = 0;
  const client = new CommercetoolsClient(config, async (url, init) => {
    const path = String(url).split('?')[0]!; // ignore SDK expand query
    if (path.endsWith('/oauth/token')) return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    if (path.endsWith('/sessions')) {
      sessions++;
      assert.deepEqual(JSON.parse(String(init?.body)), { cart: { cartRef: { id: cartId } }, metadata: { applicationKey: 'payment-only-test' } });
      return Response.json({ id: 'session-1' }, { status: 201 });
    }
    if (path.includes('/shipping-methods/matching-cart')) {
      assert.ok(cart.shippingAddress);
      return Response.json({ results: [{ id: methodId, name: 'Standard Delivery', isDefault: true }] });
    }
    if (path.endsWith('/carts/' + cartId) && init?.method === 'POST') {
      const update = JSON.parse(String(init.body)) as { version: number; actions: Array<{ action: string; address?: { state?: string } }> };
      assert.equal(update.version, cart.version);
      if (update.actions[0]?.action === 'setShippingAddress') {
        assert.deepEqual(update.actions.map(action => action.action), ['setShippingAddress', 'setBillingAddress']);
        assert.equal(update.actions[0]?.address?.state, 'Ontario');
        assert.equal(update.actions[1]?.address?.state, 'Ontario');
        cart = { ...cart, version: cart.version + 1, shippingAddress: update.actions[0]!.address, billingAddress: update.actions[1]!.address };
      } else {
        assert.equal(update.actions[0]?.action, 'setShippingMethod');
        cart = { ...cart, version: cart.version + 1, shippingInfo: { shippingMethod: { id: methodId } } };
      }
      return Response.json(cart);
    }
    if (path.endsWith('/carts/' + cartId)) return Response.json(cart);
    throw new Error('Unexpected request: ' + path);
  });

  await assert.rejects(client.createCheckoutSession(storeKey, cartId, customer), { code: 'CheckoutNotReady' });
  assert.equal(sessions, 0);
  await client.setCheckoutAddress(storeKey, {
    cartId, email: customer.email,
    address: { firstName: 'Test', lastName: 'Person', streetName: '1 Main St', city: 'Toronto', state: 'ON', postalCode: 'M5V 1A1' },
  }, customer);
  const methods = await client.listCheckoutShippingMethods(storeKey, cartId, customer);
  assert.equal(methods.shippingMethods[0]?.id, methodId);
  await client.setCheckoutShippingMethod(storeKey, cartId, methodId, customer);
  assert.deepEqual(await client.createCheckoutSession(storeKey, cartId, customer), { sessionId: 'session-1', projectKey: 'test-project', region: 'example.com' });
  assert.equal(sessions, 1);
  await assert.rejects(client.createCheckoutSession('sobeys-0520', cartId, customer), (error: unknown) => error instanceof CommerceError && error.code === 'CartNotFound');
});
