import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { CommercetoolsClient } from '../src/commercetools.js';

const config = loadConfig({
  CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'test-client', CT_CLIENT_SECRET: 'fake-secret',
  CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com',
  CT_SCOPES: 'manage_project:test-project',
});

test('store product cards include active dashboard promotion labels matched by SKU', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/product-selection-assignments?')) return Response.json({ results: [{ product: { id: 'product-1' } }] });
    if (url.endsWith('/channels/key=sobeys-0870-channel')) return Response.json({ id: 'channel-1' });
    if (url.includes('/cart-discounts?')) return Response.json({ results: [
      { id: 'shipping-discount', key: 'unrelated', requiresDiscountCode: false, value: { type: 'relative', permyriad: 10000 }, target: { type: 'shipping' } },
      {
        id: 'bundle-discount', key: 'bff-bundle-123', requiresDiscountCode: false,
        value: { type: 'absolute', money: [{ currencyCode: 'CAD', centAmount: 500 }] },
        target: {
          type: 'pattern', triggerPattern: [],
          targetPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku in ("680705-EA")', minCount: 2, maxCount: 2 }],
        },
      },
      {
        id: 'loyalty-discount', key: 'bff-customer-group-group-1-123', requiresDiscountCode: false,
        cartPredicate: 'customer.customerGroupAssignments.customerGroup.id contains "group-1"',
        value: { type: 'relative', permyriad: 500 }, target: { type: 'lineItems', predicate: 'true' },
      },
      {
        id: 'group-product-discount', key: 'bff-product-group-680705-ea-123', requiresDiscountCode: false,
        cartPredicate: 'customer.customerGroupAssignments.customerGroup.id contains "group-1"',
        value: { type: 'relative', permyriad: 1000 }, target: { type: 'lineItems', predicate: 'sku = "680705-EA"' },
      },
      {
        id: 'group-bundle-discount', key: 'bff-bundle-456', requiresDiscountCode: false,
        cartPredicate: 'customer.customerGroupAssignments.customerGroup.id contains "group-1"',
        value: { type: 'fixed', money: [{ currencyCode: 'CAD', centAmount: 500 }] },
        target: { type: 'pattern', triggerPattern: [], targetPattern: [{ type: 'CountOnLineItemUnits', predicate: 'sku in ("680705-EA")', minCount: 2, maxCount: 2 }] },
      },
    ] });
    if (url.includes('/product-discounts?')) return Response.json({ results: [{
      id: 'percentage-discount', key: 'bff-680705-ea-456', predicate: 'sku = "680705-EA"',
      value: { type: 'relative', permyriad: 1500 },
    }] });
    if (url.includes('/product-projections/product-1?')) return Response.json({
      id: 'product-1', name: { 'en-CA': 'Huggies' },
      masterVariant: {
        sku: '680705-EA', price: { value: { currencyCode: 'CAD', centAmount: 1599 } }, attributes: [],
      },
    });
    if (url.endsWith('/customers/customer-1')) return Response.json({
      customerGroupAssignments: [{ customerGroup: { id: 'group-1' } }],
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CommercetoolsClient(config, fetcher as typeof fetch);
  const result: any = await client.listStoreProducts('sobeys-0870', { id: 'customer-1', email: 'loyalty@example.com' });
  assert.deepEqual(result.products[0].offers, [
    { id: 'loyalty-discount', label: 'Loyalty offer: 5% off' },
    { id: 'bundle-discount', label: 'Buy 2, save $5.00' },
    { id: 'group-product-discount', label: '10% off' },
    { id: 'group-bundle-discount', label: '2 for $5.00' },
    { id: 'percentage-discount', label: '15% off' },
  ]);
  const anonymous: any = await client.listStoreProducts('sobeys-0870');
  assert.equal(anonymous.products[0].offers.some((offer: { id: string }) => offer.id === 'loyalty-discount'), false);
  assert.equal(anonymous.products[0].offers.some((offer: { id: string }) => offer.id === 'group-product-discount'), false);
  assert.equal(anonymous.products[0].offers.some((offer: { id: string }) => offer.id === 'group-bundle-discount'), false);
});
