import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { draftSchema, loadImportConfig, ProductTypeImporter } from '../src/catalog/product-type-importer.js';

const draft = draftSchema.parse(JSON.parse(readFileSync(new URL('../catalog/sobeys-pace-product-type.json', import.meta.url), 'utf8')));
const config = loadImportConfig({ CT_PROJECT_KEY: 'test-project', CT_CLIENT_ID: 'fake-client', CT_CLIENT_SECRET: 'fake-secret', CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com', CT_SCOPES: 'manage_product_types:test-project' });
const result = { ...draft, id: 'type-1', version: 1 };
function importer(handler: typeof fetch) {
  return new ProductTypeImporter(config, async (url, init) => String(url).endsWith('/oauth/token') ? Response.json({ access_token: 'fake-token' }) : handler(url, init));
}

test('reviewed schema has required identifiers, preserves UPC as text and excludes operational/search fields', () => {
  assert.equal(draft.attributes.length, 64);
  assert.equal(draft.attributes.find(attr => attr.name === 'pace-upc')?.type.name, 'text');
  assert.equal(draft.attributes.find(attr => attr.name === 'pace-allergens-glutenFree')?.type.name, 'boolean');
  assert.equal(draft.attributes.find(attr => attr.name === 'pace-nutrition-ingredients')?.isSearchable, false);
  assert.deepEqual(draft.attributes.filter(attr => attr.isRequired).map(attr => attr.name), ['pace-articleNumber', 'pace-uom']);
  assert.ok(!draft.attributes.some(attr => ['price', 'storeId', 'inventoryLevel', 'taxes', 'promotions', 'objectID'].some(field => attr.name === `pace-${field}`)));
  assert.equal(draftSchema.safeParse({ ...draft, attributes: [...draft.attributes, draft.attributes[0]] }).success, false);
});

test('creates missing type with reviewed payload and no product writes', async () => {
  const writes: string[] = [];
  const service = importer(async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-token');
    if (init?.method !== 'POST') return Response.json({}, { status: 404 });
    writes.push(String(url));
    assert.deepEqual(JSON.parse(String(init.body)), draft);
    return Response.json(result, { status: 201 });
  });
  assert.deepEqual(await service.apply(draft), { status: 'created', id: result.id, key: draft.key, version: 1, attributeCount: 64 });
  assert.deepEqual(writes, ['https://api.example.com/test-project/product-types']);
});

test('rerun skips matching type despite attribute ordering and API default fields', async () => {
  const service = importer(async (_url, init) => {
    assert.notEqual(init?.method, 'POST');
    return Response.json({ ...result, attributes: [...result.attributes].reverse().map(attr => ({ ...attr, inputHint: 'SingleLine' })) });
  });
  assert.equal((await service.apply(draft)).status, 'unchanged');
});

test('existing drift fails without any mutation', async () => {
  const service = importer(async (_url, init) => {
    assert.notEqual(init?.method, 'POST');
    return Response.json({ ...result, attributes: result.attributes.slice(1) });
  });
  await assert.rejects(service.apply(draft), /differs from the reviewed schema/);
});

test('concurrent creation conflict resolves matching type safely', async () => {
  let reads = 0;
  const service = importer(async (_url, init) => {
    if (init?.method === 'POST') return Response.json({}, { status: 409 });
    return ++reads === 1 ? Response.json({}, { status: 404 }) : Response.json(result);
  });
  assert.equal((await service.apply(draft)).status, 'unchanged');
});

test('API errors expose only safe codes, not upstream bodies', async () => {
  const service = importer(async (_url, init) => init?.method === 'POST'
    ? Response.json({ message: 'fake-secret', errors: [{ code: 'AttributeDefinitionTypeConflict', message: 'sensitive details' }] }, { status: 400 })
    : Response.json({}, { status: 404 }));
  await assert.rejects(service.apply(draft), error => error instanceof Error && error.message.includes('AttributeDefinitionTypeConflict') && !error.message.includes('fake-secret') && !error.message.includes('sensitive'));
});

test('config requires product permissions for the correct project and errors hide values', () => {
  assert.throws(() => loadImportConfig({ ...config, CT_SCOPES: 'manage_customers:test-project' }), /CT_SCOPES/);
  assert.throws(() => loadImportConfig({ ...config, CT_SCOPES: 'manage_product_types:another-project' }), /CT_SCOPES/);
  assert.throws(() => loadImportConfig({ CT_CLIENT_SECRET: 'hidden-secret' }), error => error instanceof Error && !error.message.includes('hidden-secret'));
});
