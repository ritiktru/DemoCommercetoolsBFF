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
