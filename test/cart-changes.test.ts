import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommercetoolsClient } from '../src/commercetools.js';
import { loadConfig } from '../src/config.js';

const cartId = 'a6e7dbb9-8397-4ee2-945b-8d9cda32b05e';
const lineItemId = '9430af3b-547e-4be4-8a6a-765c8011add0';
const money = { currencyCode: 'GBP', centAmount: 100, fractionDigits: 2 };
const cart = { id: cartId, version: 3, cartState: 'Active', totalPrice: money, lineItems: [], store: { typeId: 'store', key: 'shop' }, createdAt: 'x', lastModifiedAt: 'x' };
const config = loadConfig({ CT_PROJECT_KEY: 'p', CT_CLIENT_ID: 'c', CT_CLIENT_SECRET: 's', CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com', CT_SCOPES: 'manage_project:p' });
function client(onPost: (body: { version: number; actions: Array<Record<string, unknown>> }) => Response) {
  return new CommercetoolsClient(config, async (url, init) => {
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 't', expires_in: 3600 });
    return init?.method === 'POST' ? onPost(JSON.parse(String(init.body))) : Response.json(cart);
  });
}

test('quantity change sends changeLineItemQuantity; stale version is refused before commercetools', async () => {
  const ct = client(body => { assert.deepEqual(body, { version: 3, actions: [{ action: 'changeLineItemQuantity', lineItemId, quantity: 0 }] }); return Response.json({ ...cart, version: 4 }); });
  assert.equal(((await ct.updateStoreCartItem('shop', { cartId, version: 3, lineItemId, quantity: 0 })) as { cart: { version: number } }).cart.version, 4);
  await assert.rejects(ct.updateStoreCartItem('shop', { cartId, version: 2, lineItemId, quantity: 1 }), { status: 409, code: 'ConcurrentModification' });
});

test('unknown discount code and wrong-Store carts are rejected safely', async () => {
  const ct = client(() => Response.json({ errors: [{ code: 'ReferencedResourceNotFound' }] }, { status: 400 }));
  await assert.rejects(ct.addDiscountCode('shop', { cartId, version: 3, code: 'NOPE' }), { status: 400, code: 'InvalidDiscountCode' });
  await assert.rejects(ct.getStoreCart('other', cartId), { status: 404, code: 'CartNotFound' });
});

test('wrong password maps to 401 without leaking upstream detail', async () => {
  const ct = client(() => Response.json({ errors: [{ code: 'InvalidCredentials', message: 'secret detail' }] }, { status: 400 }));
  await assert.rejects(ct.loginCustomer('a@b.co', 'wrong-password'), { status: 401, code: 'InvalidCredentials', message: 'Email or password is incorrect' });
});

test('promotion exposes percent and cart-total threshold parsed from the cart discount predicate', async () => {
  const discount = { isActive: true, requiresDiscountCode: false, target: { type: 'totalPrice' }, value: { type: 'relative', permyriad: 1000 }, name: { 'en-US': 'Ten off' }, cartPredicate: 'totalPrice >= "2000.00 USD"' };
  const make = (over: object) => new CommercetoolsClient({ ...config, CT_PROMO_DISCOUNT_KEY: 'k' }, async url =>
    String(url).endsWith('/oauth/token') ? Response.json({ access_token: 't', expires_in: 3600 }) : Response.json({ ...discount, ...over }));
  assert.deepEqual(await make({}).getPromotion(), { promotion: { key: 'k', name: 'Ten off', percent: 10, thresholds: [{ currencyCode: 'USD', centAmount: 200000 }] } });
  assert.deepEqual((await make({ cartPredicate: 'totalPrice >= "2000.00 USD" or totalPrice >= "2000.00 GBP"' }).getPromotion()).promotion.thresholds.map(t => t.currencyCode), ['USD', 'GBP']);
  assert.deepEqual((await make({ cartPredicate: 'customer.email = "x"' }).getPromotion()).promotion.thresholds, []);
  await assert.rejects(make({ isActive: false }).getPromotion(), { status: 404 });
  await assert.rejects(make({ requiresDiscountCode: true }).getPromotion(), { status: 404 });
});

test('password reset: unknown email yields no token; bad token maps to 400', async () => {
  const unknown = client(() => Response.json({}, { status: 404 }));
  assert.equal(await unknown.createPasswordToken('nobody@example.com'), undefined);
  const bad = client(() => Response.json({ errors: [{ code: 'InvalidSubject' }] }, { status: 400 }));
  await assert.rejects(bad.resetPassword('stale', 'new-password-1'), { status: 400, code: 'InvalidResetToken' });
});
