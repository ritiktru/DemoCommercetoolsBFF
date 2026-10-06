import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommercetoolsClient } from '../src/commercetools.js';
import { loadConfig } from '../src/config.js';

const cartId = 'a6e7dbb9-8397-4ee2-945b-8d9cda32b05e';
const storeKey = 'sobeys-0870';
const hmacKey = '44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056';
const config = (delay: string) => loadConfig({
  CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'test-client', CT_CLIENT_SECRET: 'fake-secret',
  CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com', CT_SCOPES: 'manage_project:test-project',
  APP_ORIGIN: 'http://localhost:3000', ADYEN_API_KEY: 'fake-adyen', ADYEN_MERCHANT_ACCOUNT: 'TestMerchant', ADYEN_HMAC_KEY: hmacKey,
  PAYMENT_SIMULATED_DELAY_MS: delay, PAYMENT_STORE_PATH: join(mkdtempSync(join(tmpdir(), 'pay-')), 'transactions.json'),
});

function fakeCommerce() {
  const cart = {
    id: cartId, version: 3, store: { typeId: 'store', key: storeKey }, cartState: 'Active', country: 'CA', customerEmail: 'guest@example.com',
    totalPrice: { currencyCode: 'CAD', centAmount: 3999, fractionDigits: 2 },
    lineItems: [{ id: 'item-1', productId: 'product-1', quantity: 1, name: { 'en-CA': 'Test' }, variant: { id: 1 }, totalPrice: { currencyCode: 'CAD', centAmount: 3999, fractionDigits: 2 } }],
    shippingAddress: { country: 'CA' }, shippingInfo: { shippingMethodName: 'Standard' },
    createdAt: '2026-10-05T00:00:00Z', lastModifiedAt: '2026-10-05T00:00:00Z',
  };
  const calls = { sessions: [] as any[], orders: [] as any[], results: [] as string[] };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).split('?')[0]!;
    if (path.endsWith('/oauth/token')) return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    if (path === 'https://checkout-test.adyen.com/v71/sessions') {
      calls.sessions.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'CS_TEST_1', url: 'https://checkoutshopper-test.adyen.com/checkoutshopper/pay/CS_TEST_1' });
    }
    if (path === 'https://checkout-test.adyen.com/v71/sessions/CS_TEST_1') {
      calls.results.push(new URL(String(url)).searchParams.get('sessionResult')!);
      // Shape captured from a real TEST session result.
      return Response.json({ id: 'CS_TEST_1', status: 'completed', reference: 'PAY-x', payments: [{ amount: { currency: 'CAD', value: 3999 }, paymentMethod: { brand: 'visa', type: 'scheme' }, pspReference: 'CJ7CSHG2GPF28DV5', resultCode: 'Authorised' }] });
    }
    if (path.endsWith(`/carts/${cartId}`)) return Response.json(cart);
    if (path.endsWith('/orders')) {
      const body = JSON.parse(String(init?.body)); calls.orders.push(body); cart.cartState = 'Ordered';
      return Response.json({ id: 'order-1', orderNumber: body.orderNumber, totalPrice: cart.totalPrice });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fetcher: fetcher as typeof fetch };
}

test('hosted checkout: initiate, poll pending, then one paid Order carrying payment_ref_id', async () => {
  const { calls, fetcher } = fakeCommerce();
  const client = new CommercetoolsClient(config('50'), fetcher);
  const started = await client.initiateCheckout(storeKey, cartId);
  assert.match(started.paymentRefId, /^PAY-/);
  assert.equal(started.url, 'https://checkoutshopper-test.adyen.com/checkoutshopper/pay/CS_TEST_1');
  assert.deepEqual(calls.sessions[0].amount, { value: 3999, currency: 'CAD' });
  assert.equal(calls.sessions[0].mode, 'hosted');
  assert.equal(calls.sessions[0].returnUrl, `http://localhost:3000/checkout?paymentRef=${started.paymentRefId}`);

  assert.deepEqual(await client.paymentStatus(storeKey, started.paymentRefId), { status: 'pending' });
  assert.equal(calls.results.length, 0);
  // Back from Adyen: the poll carries sessionResult (Adyen's "!" kept) and the pspReference is fetched and saved once.
  const sessionResult = 'Ab02b4c0!BQABAgBQ5h+/x=';
  assert.deepEqual(await client.paymentStatus(storeKey, started.paymentRefId, sessionResult), { status: 'pending' });
  await client.paymentStatus(storeKey, started.paymentRefId, sessionResult);
  assert.deepEqual(calls.results, [sessionResult]);
  assert.equal(JSON.parse(readFileSync(client['config'].PAYMENT_STORE_PATH, 'utf8')).transactions[0].transaction_id, 'CJ7CSHG2GPF28DV5');
  await new Promise(resolve => setTimeout(resolve, 60));
  const [first, second] = await Promise.all([client.paymentStatus(storeKey, started.paymentRefId), client.paymentStatus(storeKey, started.paymentRefId)]);
  assert.equal(first.status, 'paid');
  assert.deepEqual(first, second);
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].paymentState, 'Paid');
  assert.deepEqual(calls.orders[0].custom, { type: { typeId: 'type', key: 'internal-payment-reference-type' }, fields: { internal_payment_ref_id: started.paymentRefId } });
  // After the cart is ordered, polling still answers from the stored transaction.
  assert.deepEqual(await client.paymentStatus(storeKey, started.paymentRefId), first);
  assert.equal(calls.orders.length, 1);
  await assert.rejects(client.paymentStatus('other-store', started.paymentRefId), { code: 'PaymentNotFound' });
});

test('webhook marks the payment paid only with a valid HMAC and matching amount', async () => {
  const { fetcher } = fakeCommerce();
  const client = new CommercetoolsClient(config('600000'), fetcher);
  const { paymentRefId } = await client.initiateCheckout(storeKey, cartId);
  const item = { pspReference: 'PSP1', merchantAccountCode: 'TestMerchant', merchantReference: paymentRefId, amount: { value: 3999, currency: 'CAD' }, eventCode: 'AUTHORISATION', success: 'true', paymentMethod: 'visa' };
  const sign = (i: typeof item) => createHmac('sha256', Buffer.from(hmacKey, 'hex'))
    .update([i.pspReference, '', i.merchantAccountCode, i.merchantReference, i.amount.value, i.amount.currency, i.eventCode, i.success].join(':')).digest('base64');

  assert.throws(() => client.handlePaymentWebhook({ notificationItems: [{ NotificationRequestItem: { ...item, additionalData: { hmacSignature: 'bad' } } }] }), { code: 'InvalidSignature' });
  assert.deepEqual(await client.paymentStatus(storeKey, paymentRefId), { status: 'pending' });

  assert.equal(client.handlePaymentWebhook({ notificationItems: [{ NotificationRequestItem: { ...item, additionalData: { hmacSignature: sign(item) } } }] }), '[accepted]');
  assert.equal((await client.paymentStatus(storeKey, paymentRefId)).status, 'paid');
  const saved = JSON.parse(readFileSync(client['config'].PAYMENT_STORE_PATH, 'utf8')).transactions[0];
  assert.equal(saved.payment_method, 'visa');
  assert.equal(saved.eventCode, 'AUTHORISATION');
});
