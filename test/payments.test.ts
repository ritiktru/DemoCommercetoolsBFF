import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { CommercetoolsClient } from '../src/commercetools.js';
import { loadConfig } from '../src/config.js';

const origin = 'http://localhost:3000';
const cartId = 'a6e7dbb9-8397-4ee2-945b-8d9cda32b05e';
const storeKey = 'sobeys-0870';
const appKey = 'fake-gp-app-key';
const config = loadConfig({
  CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'test-client', CT_CLIENT_SECRET: 'fake-secret',
  CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com', CT_SCOPES: 'manage_project:test-project',
  GP_APP_ID: 'fake-gp-app', GP_APP_KEY: appKey,
});
const cad = (centAmount: number) => ({ currencyCode: 'CAD', centAmount, fractionDigits: 2 });
const ctError = (status: number, code = 'InvalidOperation') => Response.json({ statusCode: status, message: code, errors: [{ code, message: code }] }, { status });

test('card payment: amount comes from the cart, charge and webhook create exactly one paid order, forged webhooks are rejected', async () => {
  const cart = {
    id: cartId, version: 1, store: { typeId: 'store', key: storeKey }, cartState: 'Active', country: 'CA',
    totalPrice: cad(3999), taxedPrice: { totalGross: cad(4519), totalTax: cad(520) },
    lineItems: [{ id: 'item-1', productId: 'product-1', quantity: 1, name: { 'en-CA': 'Test' }, variant: { id: 1, sku: 'test-EA' }, totalPrice: cad(3999) }],
    shippingAddress: { country: 'CA' }, shippingInfo: { shippingMethodName: 'Standard' },
    paymentInfo: { payments: [] as Array<{ typeId: string; id: string }> },
    createdAt: '2026-09-30T00:00:00Z', lastModifiedAt: '2026-09-30T00:00:00Z',
  };
  const payments = new Map<string, { id: string; version: number; amountPlanned: object; paymentMethodInfo: object; transactions: Array<{ interactionId: string; type: string; state: string; amount: object }> }>();
  const orders = new Map<string, { id: string; orderNumber: string; paymentState: string; totalPrice: object }>();
  let charges = 0;
  let gpTransaction: Record<string, string> | undefined;

  const client = new CommercetoolsClient(config, async (url, init) => {
    const { pathname, searchParams } = new URL(String(url));
    if (pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'ct-token', expires_in: 3600 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    // Global Payments
    if (pathname === '/ucp/accesstoken') {
      assert.equal(body.secret, createHash('sha512').update(body.nonce + appKey).digest('hex'));
      return body.permissions
        ? (assert.deepEqual(body.permissions, ['PMT_POST_Create_Single']), Response.json({ token: 'browser-token', seconds_to_expire: 600 }))
        : Response.json({ token: 'server-token', seconds_to_expire: 3600, scope: { accounts: [{ id: 'TKA_1', name: 'tokenization' }, { id: 'TRA_1', name: 'transaction_processing' }] } });
    }
    if (pathname === '/ucp/transactions' && init?.method === 'POST') {
      charges++;
      assert.equal(headers.get('authorization'), 'Bearer server-token');
      assert.equal(headers.get('x-gp-idempotency'), body.reference);
      assert.equal(body.account_name, 'transaction_processing');
      assert.equal(body.amount, '4519'); // taxed cart total, never a browser-supplied amount
      assert.equal(body.payment_method.id, 'PMT_card-1');
      gpTransaction = { id: 'TRN_1', status: 'CAPTURED', amount: body.amount, currency: body.currency, reference: body.reference };
      return Response.json(gpTransaction);
    }
    if (pathname === '/ucp/transactions/TRN_1') return gpTransaction ? Response.json(gpTransaction) : Response.json({}, { status: 404 });
    // commercetools
    const path = pathname.replace('/test-project', '');
    if (path === `/carts/${cartId}` && init?.method === 'POST') {
      if (body.version !== cart.version) return ctError(409, 'ConcurrentModification');
      for (const action of body.actions) if (action.action === 'addPayment') cart.paymentInfo.payments.push(action.payment);
      cart.version++;
      return Response.json(cart);
    }
    if (path === `/carts/${cartId}`) return Response.json(cart);
    if (path === '/carts') return Response.json({ results: cart.paymentInfo.payments.some(p => searchParams.get('where')?.includes(p.id)) ? [cart] : [] });
    if (path === '/payments' && init?.method === 'POST') {
      const payment = { id: crypto.randomUUID(), version: 1, ...body, transactions: [] };
      payments.set(payment.id, payment);
      return Response.json(payment, { status: 201 });
    }
    const payment = payments.get(path.replace('/payments/', ''));
    if (path.startsWith('/payments/')) {
      if (!payment) return ctError(404, 'ResourceNotFound');
      if (init?.method === 'POST') {
        if (body.version !== payment.version) return ctError(409, 'ConcurrentModification');
        for (const action of body.actions) payment.transactions.push(action.transaction);
        payment.version++;
      }
      return Response.json(payment);
    }
    if (path.startsWith('/orders/order-number=')) {
      const order = orders.get(decodeURIComponent(path.replace('/orders/order-number=', '')));
      return order ? Response.json(order) : ctError(404, 'ResourceNotFound');
    }
    if (path === '/orders' && init?.method === 'POST') {
      if (cart.cartState !== 'Active' || orders.has(body.orderNumber)) return ctError(400, 'DuplicateField');
      assert.equal(body.paymentState, 'Paid');
      assert.deepEqual(body.custom, { type: { typeId: 'type', key: 'internal-payment-reference-type' }, fields: { internal_payment_ref_id: cart.paymentInfo.payments[0]!.id } });
      const order = { id: 'order-1', orderNumber: body.orderNumber, paymentState: body.paymentState, totalPrice: cart.totalPrice, taxedPrice: cart.taxedPrice };
      orders.set(order.orderNumber, order); cart.cartState = 'Ordered';
      return Response.json(order, { status: 201 });
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${pathname}`);
  });

  const app = await createApp(client, { origin, customers: client }, client, client);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const post = (path: string, input: unknown, headers: Record<string, string> = { Origin: origin }) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof input === 'string' ? input : JSON.stringify(input) });
  const shop = `/api/storefront/stores/${storeKey}`;
  try {
    const started = await post(`${shop}/payments`, { cartId });
    assert.equal(started.status, 201, JSON.stringify(await started.clone().json()));
    const { paymentId, accessToken, env, amount } = await started.json();
    assert.deepEqual({ accessToken, env, amount }, { accessToken: 'browser-token', env: 'sandbox', amount: { currencyCode: 'CAD', centAmount: 4519 } });
    assert.deepEqual(cart.paymentInfo.payments, [{ typeId: 'payment', id: paymentId }]);

    assert.equal((await post(`${shop}/payments/charge`, { cartId, paymentId, cardToken: 'PMT_card-1', amount: 1 })).status, 400);
    assert.equal((await post(`${shop}/payments/charge`, { cartId, paymentId, cardToken: 'PMT_card-1' }, {})).status, 403);
    cart.taxedPrice.totalGross = cad(9999);
    const changed = await post(`${shop}/payments/charge`, { cartId, paymentId, cardToken: 'PMT_card-1' });
    assert.equal((await changed.json()).error.code, 'CartChanged');
    cart.taxedPrice.totalGross = cad(4519);
    assert.equal(charges, 0);

    const charged = await post(`${shop}/payments/charge`, { cartId, paymentId, cardToken: 'PMT_card-1' });
    assert.equal(charged.status, 200);
    const orderNumber = `SO-${createHash('sha256').update(cartId).digest('hex').slice(0, 10).toUpperCase()}`;
    assert.equal((await charged.json()).order.orderNumber, orderNumber);
    assert.equal(charges, 1);

    const hook = `{"id":"TRN_1","status":"CAPTURED"}`;
    const sign = (raw: string, key = appKey) => createHash('sha512').update(raw + key).digest('hex');
    assert.equal((await post('/api/payments/globalpayments/webhook', hook, {})).status, 401);
    assert.equal((await post('/api/payments/globalpayments/webhook', hook, { 'X-GP-Signature': sign(hook, 'wrong-key') })).status, 401);
    assert.equal((await post('/api/payments/globalpayments/webhook', hook, { 'X-GP-Signature': sign(`${hook} `) })).status, 401);
    for (let delivery = 0; delivery < 2; delivery++) {
      const accepted = await post('/api/payments/globalpayments/webhook', hook, { 'X-GP-Signature': sign(hook) });
      assert.equal(accepted.status, 200);
    }
    assert.equal(orders.size, 1);
    assert.equal(payments.get(paymentId)!.transactions.length, 1);
    assert.equal(charges, 1);
    assert.equal((await post(`${shop}/orders`, { cartId })).status, 404); // the unpaid order route is gone
  } finally { await app.close(); }
});
