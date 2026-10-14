import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommercetoolsPromotionClient } from '../src/promotions/promotions-client.js';

const config = {
  CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'client', CT_CLIENT_SECRET: 'secret',
  CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com',
  CT_SCOPES: 'manage_project:test-project', DELIVERY_PASS_CUSTOM_TYPE_KEY: 'pass',
  DELIVERY_PASS_PRODUCT_KEY: 'pass-product', DELIVERY_PASS_SKU: 'PASS', DELIVERY_PASS_DURATION_MONTHS: 12,
} as const;

test('promotion client verifies SKU and creates a relative Product Discount', async () => {
  let draft: Record<string, unknown> | undefined;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: 1 });
    if (url.endsWith('/product-discounts') && init?.method === 'POST') {
      draft = JSON.parse(String(init.body));
      return Response.json({
        id: 'discount-id', key: draft?.key, name: draft?.name, value: draft?.value,
        predicate: draft?.predicate, isActive: true, createdAt: '2026-10-13T00:00:00.000Z',
      }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  const result = await client.createPromotion({ sku: '680705-EA', name: 'Huggies 10% off', discountType: 'percentage', discount: 10 });
  assert.equal(result.promotion.sku, '680705-EA');
  assert.deepEqual(draft?.value, { type: 'relative', permyriad: 1000 });
  assert.equal(draft?.predicate, 'sku = "680705-EA"');
  assert.equal(draft?.isActive, true);
});

test('promotion client rejects an unknown SKU before creating a discount', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: 0 });
    throw new Error('Product Discount creation must not be called');
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  await assert.rejects(
    client.createPromotion({ sku: 'MISSING', name: 'Missing SKU', discountType: 'fixed', discount: 5 }),
    (error: unknown) => error instanceof Error && error.message.includes('MISSING'),
  );
});

test('promotion client creates a fixed final price for one SKU as a Cart Discount', async () => {
  let draft: any;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: 1 });
    if (url.endsWith('/cart-discounts') && init?.method === 'POST') {
      draft = JSON.parse(String(init.body));
      return Response.json({
        id: 'cart-discount-id', key: draft.key, name: draft.name, value: draft.value,
        cartPredicate: draft.cartPredicate, target: draft.target, isActive: true,
        createdAt: '2026-10-14T00:00:00.000Z',
      }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  const result = await client.createPromotion({ sku: '680705-EA', name: 'Huggies for $2', discountType: 'finalPrice', discount: 2 });
  assert.equal(result.promotion.resourceType, 'cart-discount');
  assert.deepEqual(draft.value, {
    type: 'fixed',
    money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: 200, fractionDigits: 2 }],
    applicationMode: 'IndividualApplication',
  });
  assert.deepEqual(draft.target, { type: 'lineItems', predicate: 'sku = "680705-EA"' });
  assert.equal(draft.cartPredicate, '1 = 1');
  assert.equal(draft.requiresDiscountCode, false);
});

test('promotion client creates a repeating buy one get one free promotion for one SKU', async () => {
  let draft: any;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: 1 });
    if (url.endsWith('/cart-discounts') && init?.method === 'POST') {
      draft = JSON.parse(String(init.body));
      return Response.json({
        id: 'bogo-id', key: draft.key, name: draft.name, value: draft.value,
        cartPredicate: draft.cartPredicate, target: draft.target, isActive: true,
        createdAt: '2026-10-14T00:00:00.000Z',
      }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  const result = await client.createPromotion({
    sku: '680705-EA', name: 'Huggies BOGO', discountType: 'bogo',
    buyQuantity: 1, freeQuantity: 1, repeat: true,
  });
  assert.equal(result.promotion.resourceType, 'cart-discount');
  assert.deepEqual(draft.value, { type: 'relative', permyriad: 10000, applicationMode: 'IndividualApplication' });
  assert.deepEqual(draft.target, {
    type: 'pattern',
    triggerPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku = "680705-EA"', minCount: 1, maxCount: 1 }],
    targetPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku = "680705-EA"', minCount: 1, maxCount: 1 }],
    selectionMode: 'Cheapest',
  });
  assert.equal(draft.requiresDiscountCode, false);
});

test('promotion client lists BOGO promotions created from the dashboard', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-discounts?')) return Response.json({ results: [] });
    if (url.includes('/cart-discounts?')) return Response.json({ results: [{
      id: 'bogo-id', key: 'bff-bogo-680705-ea-123', name: { 'en-CA': 'Huggies BOGO' },
      value: { type: 'relative', permyriad: 10000, applicationMode: 'IndividualApplication' },
      cartPredicate: '1 = 1', isActive: true, createdAt: '2026-10-14T00:00:00.000Z',
      target: {
        type: 'pattern',
        triggerPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku = "680705-EA"', minCount: 1, maxCount: 1 }],
        targetPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku = "680705-EA"', minCount: 1, maxCount: 1 }],
        selectionMode: 'Cheapest',
      },
    }] });
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  const result: any = await client.listPromotions();
  assert.deepEqual(result.promotions[0].discount, {
    type: 'bogo', value: 100, buyQuantity: 1, freeQuantity: 1, repeat: true,
  });
  assert.equal(result.promotions[0].resourceType, 'cart-discount');
});

test('promotion client reads the latest version before removing a Product Discount', async () => {
  const id = 'f69eba03-187b-4292-b92f-4f6df88f2bb9';
  const requests: Array<{ url: string; method?: string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, method: init?.method });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.endsWith(`/product-discounts/${id}`)) return Response.json({ id, version: 7 });
    if (url.endsWith(`/product-discounts/${id}?version=7`) && init?.method === 'DELETE') {
      return Response.json({ id, version: 8 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  assert.deepEqual(await client.removePromotion(id), { removed: true, id });
  assert.equal(requests.at(-1)?.method, 'DELETE');
  assert.ok(requests.at(-1)?.url.endsWith('?version=7'));
});

test('promotion client removes a final-price Cart Discount from the product promotion dashboard', async () => {
  const id = 'f69eba03-187b-4292-b92f-4f6df88f2bb9';
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.endsWith(`/cart-discounts/${id}`)) return Response.json({ id, version: 4 });
    if (url.endsWith(`/cart-discounts/${id}?version=4`) && init?.method === 'DELETE') return Response.json({ id, version: 5 });
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  assert.deepEqual(await client.removePromotion(id, 'cart-discount'), { removed: true, id });
});

test('promotion client creates a repeating mix-and-match fixed bundle price', async () => {
  let draft: any;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: 1 });
    if (url.endsWith('/cart-discounts') && init?.method === 'POST') {
      draft = JSON.parse(String(init.body));
      return Response.json({ id: 'cart-discount-id', key: draft.key, name: draft.name, value: draft.value, cartPredicate: draft.cartPredicate, target: draft.target, isActive: true, createdAt: '2026-10-13T00:00:00.000Z' }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  await client.createBundlePromotion({ skus: ['SKU-A', 'SKU-B', 'SKU-C'], name: 'Any 2 for $10', promotionType: 'fixedBundlePrice', quantity: 2, discount: 10, repeat: true });
  assert.deepEqual(draft.value, { type: 'fixed', money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: 1000, fractionDigits: 2 }], applicationMode: 'EvenDistribution' });
  assert.deepEqual(draft.target, {
    type: 'pattern', triggerPattern: [],
    targetPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku in ("SKU-A", "SKU-B", "SKU-C")', minCount: 2, maxCount: 2 }],
    selectionMode: 'Cheapest',
  });
  assert.equal(draft.requiresDiscountCode, false);
});

test('promotion client creates a repeating fixed bundle price for multiple units of one SKU', async () => {
  let draft: any;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: 1 });
    if (url.endsWith('/cart-discounts') && init?.method === 'POST') {
      draft = JSON.parse(String(init.body));
      return Response.json({ id: 'same-sku-bundle-id', key: draft.key, name: draft.name, value: draft.value, cartPredicate: draft.cartPredicate, target: draft.target, isActive: true, createdAt: '2026-10-14T00:00:00.000Z' }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  await client.createBundlePromotion({ skus: ['680705-EA'], name: 'Buy 2 for $5', promotionType: 'fixedBundlePrice', quantity: 2, discount: 5, repeat: true });
  assert.deepEqual(draft.value, {
    type: 'fixed',
    money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: 500, fractionDigits: 2 }],
    applicationMode: 'EvenDistribution',
  });
  assert.deepEqual(draft.target, {
    type: 'pattern', triggerPattern: [],
    targetPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku in ("680705-EA")', minCount: 2, maxCount: 2 }],
    selectionMode: 'Cheapest',
  });
});

test('promotion client creates buy two get five dollars off for one SKU', async () => {
  let draft: any;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: 1 });
    if (url.endsWith('/cart-discounts') && init?.method === 'POST') {
      draft = JSON.parse(String(init.body));
      return Response.json({ id: 'amount-off-id', key: draft.key, name: draft.name, value: draft.value, cartPredicate: draft.cartPredicate, target: draft.target, isActive: true, createdAt: '2026-10-14T00:00:00.000Z' }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  await client.createBundlePromotion({ skus: ['680705-EA'], name: 'Buy 2 get $5 off', promotionType: 'amountOff', quantity: 2, discount: 5, repeat: true });
  assert.deepEqual(draft.value, {
    type: 'absolute',
    money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: 500, fractionDigits: 2 }],
    applicationMode: 'EvenDistribution',
  });
  assert.deepEqual(draft.target, {
    type: 'pattern', triggerPattern: [],
    targetPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku in ("680705-EA")', minCount: 2, maxCount: 2 }],
    selectionMode: 'Cheapest',
  });
});

test('promotion client creates a one-time percentage bundle promotion', async () => {
  let draft: any;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: 1 });
    if (url.endsWith('/cart-discounts') && init?.method === 'POST') {
      draft = JSON.parse(String(init.body));
      return Response.json({ id: 'cart-discount-id', key: draft.key, name: draft.name, value: draft.value, cartPredicate: draft.cartPredicate, target: draft.target, isActive: true, createdAt: '2026-10-13T00:00:00.000Z' }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  await client.createBundlePromotion({ skus: ['SKU-A', 'SKU-B'], name: 'Any 2 get 20% off', promotionType: 'percentageOff', quantity: 2, discount: 20, repeat: false });
  assert.deepEqual(draft.value, { type: 'relative', permyriad: 2000, applicationMode: 'IndividualApplication' });
  assert.equal(draft.target.maxOccurrence, 1);
});

test('promotion client reports all missing eligible SKUs before creating a bundle promotion', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-projections?')) return Response.json({ total: url.includes('SKU-A') ? 1 : 0 });
    throw new Error('Cart Discount creation must not be called');
  };
  const client = new CommercetoolsPromotionClient(config, fetcher as typeof fetch);
  await assert.rejects(
    client.createBundlePromotion({ skus: ['SKU-A', 'MISSING'], name: 'Bundle', promotionType: 'fixedBundlePrice', quantity: 2, discount: 10, repeat: true }),
    (error: unknown) => error instanceof Error && error.message.includes('MISSING'),
  );
});
