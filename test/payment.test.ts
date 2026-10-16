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
const adminKey = 'admin-key-for-tests-0001';
const config = (delay: string) => loadConfig({
  CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'test-client', CT_CLIENT_SECRET: 'fake-secret',
  CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com', CT_SCOPES: 'manage_project:test-project',
  APP_ORIGIN: 'http://localhost:3000', ADYEN_API_KEY: 'fake-adyen', ADYEN_MERCHANT_ACCOUNT: 'TestMerchant', ADYEN_HMAC_KEY: hmacKey,
  ADMIN_API_KEY: adminKey, PAYMENT_SIMULATED_DELAY_MS: delay, PAYMENT_STORE_PATH: join(mkdtempSync(join(tmpdir(), 'pay-')), 'transactions.json'),
});

function fakeCommerce(customerId?: string) {
  const cart = {
    id: cartId, version: 3, store: { typeId: 'store', key: storeKey }, cartState: 'Active', country: 'CA', customerEmail: 'guest@example.com', customerId,
    totalPrice: { currencyCode: 'CAD', centAmount: 3999, fractionDigits: 2 },
    lineItems: [{ id: 'item-1', productId: 'product-1', quantity: 1, name: { 'en-CA': 'Test' }, variant: { id: 1 }, totalPrice: { currencyCode: 'CAD', centAmount: 3999, fractionDigits: 2 } }],
    shippingAddress: { country: 'CA' }, shippingInfo: { shippingMethodName: 'Standard' },
    createdAt: '2026-10-05T00:00:00Z', lastModifiedAt: '2026-10-05T00:00:00Z',
  };
  const calls = { sessions: [] as any[], orders: [] as any[], results: [] as string[], mods: [] as Array<{ path: string; body: any }>, orderUpdates: [] as any[], cartActions: [] as any[], ctPayment: undefined as any, paymentUpdates: [] as any[] };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).split('?')[0]!;
    if (path.endsWith('/oauth/token')) return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    if (path === 'https://checkout-test.adyen.com/v71/sessions') {
      calls.sessions.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'CS_TEST_1', sessionData: 'Ab02b4c0!SESSIONDATA' });
    }
    if (path === 'https://checkout-test.adyen.com/v71/sessions/CS_TEST_1') {
      calls.results.push(new URL(String(url)).searchParams.get('sessionResult')!);
      // Shape captured from a real TEST session result.
      return Response.json({ id: 'CS_TEST_1', status: 'completed', reference: 'PAY-x', payments: [{ amount: { currency: 'CAD', value: 3999 }, paymentMethod: { brand: 'visa', type: 'scheme' }, pspReference: 'CJ7CSHG2GPF28DV5', resultCode: 'Authorised' }] });
    }
    const mod = /\/v71\/payments\/([^/]+)\/(captures|refunds|cancels)$/.exec(path);
    if (mod) { calls.mods.push({ path: `${mod[1]}/${mod[2]}`, body: JSON.parse(String(init?.body)) }); return Response.json({ pspReference: `MOD${calls.mods.length}`, status: 'received' }, { status: 201 }); }
    if (path.endsWith('/orders/order-1')) {
      if (init?.method === 'POST') { calls.orderUpdates.push(JSON.parse(String(init.body))); return Response.json({ id: 'order-1', version: 2 }); }
      return Response.json({ id: 'order-1', version: 1 });
    }
    if (path === 'https://api.example.com/test-project/payments' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      calls.ctPayment = { ...body, id: 'ctpay-1', version: 1, transactions: body.transactions.map((t: any, i: number) => ({ ...t, id: `tx-${i + 1}` })) };
      return Response.json(calls.ctPayment, { status: 201 });
    }
    if (path === 'https://api.example.com/test-project/payments/ctpay-1') {
      if (init?.method === 'POST') {
        const { actions } = JSON.parse(String(init.body)); calls.paymentUpdates.push(actions);
        for (const a of actions) {
          if (a.action === 'addTransaction') calls.ctPayment.transactions.push({ ...a.transaction, id: `tx-${calls.ctPayment.transactions.length + 1}` });
          if (a.action === 'changeTransactionState') calls.ctPayment.transactions.find((t: any) => t.id === a.transactionId).state = a.state;
          if (a.action === 'setStatusInterfaceCode') calls.ctPayment.paymentStatus.interfaceCode = a.interfaceCode;
        }
        calls.ctPayment.version++;
      }
      return Response.json(calls.ctPayment);
    }
    if (path.endsWith(`/carts/${cartId}`) && init?.method === 'POST') {
      const { actions } = JSON.parse(String(init.body)); calls.cartActions.push(...actions); cart.version++;
      return Response.json(cart);
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

test('drop-in checkout: initiate, poll pending, then one paid Order carrying payment_ref_id', async () => {
  const { calls, fetcher } = fakeCommerce();
  const client = new CommercetoolsClient(config('50'), fetcher);
  const started = await client.initiateCheckout(storeKey, cartId);
  assert.match(started.paymentRefId, /^PAY-/);
  assert.deepEqual([started.sessionId, started.sessionData], ['CS_TEST_1', 'Ab02b4c0!SESSIONDATA']);
  assert.equal('url' in started, false);
  assert.deepEqual(calls.sessions[0].amount, { value: 3999, currency: 'CAD' });
  assert.deepEqual([calls.sessions[0].mode, calls.sessions[0].channel], ['embedded', 'Web']);
  assert.deepEqual(calls.sessions[0].additionalData, { manualCapture: 'true' });
  assert.equal(calls.sessions[0].shopperReference, undefined); // guests get no saved cards
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
  assert.equal(calls.orders[0].paymentState, 'Pending'); // held, not captured
  // The commercetools Payment exists before the order and sits on the cart, so the order carries it.
  assert.deepEqual([calls.ctPayment.key, calls.ctPayment.interfaceId, calls.ctPayment.paymentStatus.interfaceCode], [started.paymentRefId, 'CJ7CSHG2GPF28DV5', 'AUTHORISED']);
  assert.deepEqual(calls.ctPayment.transactions.map((t: any) => [t.type, t.amount.centAmount, t.state]), [['Authorization', 3999, 'Success']]);
  assert.deepEqual(calls.cartActions, [{ action: 'addPayment', payment: { typeId: 'payment', id: 'ctpay-1' } }]);
  assert.equal(calls.orders[0].version, 4);
  assert.equal(JSON.parse(readFileSync(client['config'].PAYMENT_STORE_PATH, 'utf8')).transactions[0].status, 'AUTHORISED');
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
  assert.equal(saved.status, 'AUTHORISED');
});

const sign = (item: Record<string, any>) => {
  const payload = [item.pspReference, item.originalReference ?? '', item.merchantAccountCode, item.merchantReference, item.amount.value, item.amount.currency, item.eventCode, item.success].join(':');
  return { notificationItems: [{ NotificationRequestItem: { ...item, additionalData: { hmacSignature: createHmac('sha256', Buffer.from(hmacKey, 'hex')).update(payload).digest('base64') } } }] };
};
const stored = (client: CommercetoolsClient) => JSON.parse(readFileSync(client['config'].PAYMENT_STORE_PATH, 'utf8')).transactions[0];

test('signed-in customers get saved cards through Adyen; guests do not', async () => {
  const { calls, fetcher } = fakeCommerce('customer-1');
  const client = new CommercetoolsClient(config('600000'), fetcher);
  await client.initiateCheckout(storeKey, cartId, { id: 'customer-1', email: 'person@example.com' } as any);
  assert.deepEqual([calls.sessions[0].shopperReference, calls.sessions[0].storePaymentMethodMode, calls.sessions[0].recurringProcessingModel], ['customer-1', 'askForConsent', 'CardOnFile']);
});

test('admin capture, refund and cancel follow the payment statuses and call Adyen', async () => {
  const { calls, fetcher } = fakeCommerce();
  const client = new CommercetoolsClient(config('600000'), fetcher);
  const { paymentRefId } = await client.initiateCheckout(storeKey, cartId);
  const auth = { pspReference: 'PSP1', merchantAccountCode: 'TestMerchant', merchantReference: paymentRefId, amount: { value: 3999, currency: 'CAD' }, success: 'true' };

  assert.throws(() => client.listPayments('wrong-key-wrong-key-0'), { code: 'Unauthorized' });
  await assert.rejects(client.modifyPayment(adminKey, paymentRefId, 'CAPTURE'), { code: 'NoPspReference' });
  client.handlePaymentWebhook(sign({ ...auth, eventCode: 'AUTHORISATION' }));
  await client.paymentStatus(storeKey, paymentRefId); // creates the order (paymentState Pending)
  await assert.rejects(client.modifyPayment(adminKey, paymentRefId, 'REFUND', 100), { code: 'InvalidPaymentState' });
  await assert.rejects(client.modifyPayment(adminKey, paymentRefId, 'CAPTURE', 4000), { code: 'InvalidAmount' });

  // Hold 39.99, capture 35.00: Adyen releases the rest; the commercetools order becomes Paid.
  const captured = await client.modifyPayment(adminKey, paymentRefId, 'CAPTURE', 3500) as any;
  assert.deepEqual([captured.status, captured.capturedAmount], ['CAPTURED', 3500]);
  assert.deepEqual(calls.mods[0], { path: 'PSP1/captures', body: { merchantAccount: 'TestMerchant', reference: `${paymentRefId}:CAPTURE:1`, amount: { value: 3500, currency: 'CAD' } } });
  assert.deepEqual(calls.orderUpdates.at(-1), { version: 1, actions: [{ action: 'changePaymentState', paymentState: 'Paid' }] });
  assert.deepEqual(calls.ctPayment.transactions.map((t: any) => [t.type, t.amount.centAmount, t.interactionId]), [['Authorization', 3999, 'PSP1'], ['Charge', 3500, 'MOD1']]);
  assert.equal(calls.ctPayment.paymentStatus.interfaceCode, 'CAPTURED');
  await assert.rejects(client.modifyPayment(adminKey, paymentRefId, 'CANCEL'), { code: 'InvalidPaymentState' });

  // The CAPTURE webhook confirms the request; a repeat changes nothing.
  const captureEvent = sign({ ...auth, pspReference: 'MOD1', originalReference: 'PSP1', merchantReference: `${paymentRefId}:CAPTURE:1`, amount: { value: 3500, currency: 'CAD' }, eventCode: 'CAPTURE' });
  client.handlePaymentWebhook(captureEvent); client.handlePaymentWebhook(captureEvent);
  assert.deepEqual(stored(client).operations.map((o: any) => o.status), ['SUCCEEDED']);

  assert.equal((await client.modifyPayment(adminKey, paymentRefId, 'REFUND', 1000) as any).status, 'PARTIALLY_REFUNDED');
  await assert.rejects(client.modifyPayment(adminKey, paymentRefId, 'REFUND', 2501), { code: 'InvalidAmount' });
  // A failed refund webhook reverts that refund.
  client.handlePaymentWebhook(sign({ ...auth, pspReference: 'MOD2', originalReference: 'PSP1', merchantReference: `${paymentRefId}:REFUND:1`, amount: { value: 1000, currency: 'CAD' }, eventCode: 'REFUND_FAILED' }));
  assert.deepEqual([stored(client).status, stored(client).refunded_amount], ['CAPTURED', 0]);
  await new Promise(resolve => setTimeout(resolve, 20)); // webhook-driven commercetools updates run in the background
  assert.deepEqual(calls.ctPayment.transactions.map((t: any) => [t.type, t.state]), [['Authorization', 'Success'], ['Charge', 'Success'], ['Refund', 'Failure']]);
  assert.equal(calls.ctPayment.paymentStatus.interfaceCode, 'CAPTURED');
  const refunded = await client.modifyPayment(adminKey, paymentRefId, 'REFUND') as any; // default: everything still refundable
  assert.deepEqual([refunded.status, refunded.refundedAmount, calls.mods.at(-1)!.body.amount.value], ['REFUNDED', 3500, 3500]);
  assert.deepEqual([calls.ctPayment.transactions.at(-1).type, calls.ctPayment.transactions.at(-1).amount.centAmount, calls.ctPayment.paymentStatus.interfaceCode], ['Refund', 3500, 'REFUNDED']);
});

test('cancel releases a hold, and a capture that later fails goes back to AUTHORISED', async () => {
  const { calls, fetcher } = fakeCommerce();
  const client = new CommercetoolsClient(config('600000'), fetcher);
  const { paymentRefId } = await client.initiateCheckout(storeKey, cartId);
  const auth = { pspReference: 'PSP1', merchantAccountCode: 'TestMerchant', merchantReference: paymentRefId, amount: { value: 3999, currency: 'CAD' }, success: 'true' };
  client.handlePaymentWebhook(sign({ ...auth, eventCode: 'AUTHORISATION' }));
  await client.modifyPayment(adminKey, paymentRefId, 'CAPTURE');
  client.handlePaymentWebhook(sign({ ...auth, pspReference: 'MOD1', originalReference: 'PSP1', merchantReference: `${paymentRefId}:CAPTURE:1`, eventCode: 'CAPTURE_FAILED', reason: 'Insufficient balance' }));
  assert.deepEqual([stored(client).status, stored(client).captured_amount, stored(client).failure_reason], ['AUTHORISED', 0, 'Insufficient balance']);
  assert.equal((await client.modifyPayment(adminKey, paymentRefId, 'CANCEL') as any).status, 'CANCELLED');
  assert.equal(calls.mods.at(-1)!.path, 'PSP1/cancels');
  assert.deepEqual(await client.paymentStatus(storeKey, paymentRefId), { status: 'failed' });
});
