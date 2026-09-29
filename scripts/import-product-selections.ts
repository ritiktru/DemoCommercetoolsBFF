import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { loadStoreImportConfig } from '../src/stores/store-importer.js';

const key = z.string().min(2).max(256).regex(/^[A-Za-z0-9_-]+$/);
const manifestSchema = z.object({
  schemaVersion: z.literal(1), purpose: z.string().min(1),
  selections: z.array(z.object({ storeKey: key, key, name: z.string().min(1), productKeys: z.array(key).min(1) })).min(1),
}).superRefine((data, ctx) => {
  const stores = new Set<string>(); const selections = new Set<string>();
  for (const [index, item] of data.selections.entries()) {
    if (stores.has(item.storeKey)) ctx.addIssue({ code: 'custom', message: 'Duplicate Store', path: ['selections', index, 'storeKey'] });
    if (selections.has(item.key)) ctx.addIssue({ code: 'custom', message: 'Duplicate Product Selection', path: ['selections', index, 'key'] });
    if (new Set(item.productKeys).size !== item.productKeys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate Product', path: ['selections', index, 'productKeys'] });
    stores.add(item.storeKey); selections.add(item.key);
  }
});
const selectionSchema = z.object({ id: z.string(), version: z.number().int(), key, mode: z.literal('Individual'), productCount: z.number().int() });
const storeSchema = z.object({ id: z.string(), version: z.number().int(), key, productSelections: z.array(z.object({ productSelection: z.object({ id: z.string() }), active: z.boolean() })) });

async function main() {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !['--dry-run', '--apply'].includes(mode))) throw new Error('Usage: npm run catalog:selections -- [--dry-run|--apply]');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL('../imports/pace-product-selections-poc.json', import.meta.url), 'utf8')));
  if (mode !== '--apply') {
    console.log(JSON.stringify({ mode: 'dry-run', selections: manifest.selections.length, assignments: manifest.selections.reduce((sum, item) => sum + item.productKeys.length, 0), stores: manifest.selections.map(item => item.storeKey), message: 'Manifest validated locally. No network requests or commercetools writes.' }, null, 2));
    return;
  }
  const config = loadStoreImportConfig(process.env);
  const tokenResponse = await fetch(`${config.CT_AUTH_URL.replace(/\/$/, '')}/oauth/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Basic ${Buffer.from(`${config.CT_CLIENT_ID}:${config.CT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: config.CT_SCOPES }) });
  if (!tokenResponse.ok) throw new Error(`Authentication failed (HTTP ${tokenResponse.status})`);
  const token = z.object({ access_token: z.string() }).parse(await tokenResponse.json()).access_token;
  const base = `${config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(config.CT_PROJECT_KEY)}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  let selectionsCreated = 0; let selectionsReused = 0; let productAssignmentsApplied = 0; let storesActivated = 0; let storesAlreadyActive = 0;
  for (const item of manifest.selections) {
    for (const productKey of item.productKeys) {
      const product = await request(`/products/key=${encodeURIComponent(productKey)}`);
      if (!product.ok) throw new Error(`Required Product ${productKey} was not found (HTTP ${product.status})`);
    }
    let response = await request(`/product-selections/key=${encodeURIComponent(item.key)}`);
    let selection;
    if (response.status === 404) {
      response = await request('/product-selections', { method: 'POST', body: JSON.stringify({ key: item.key, name: { 'en-CA': item.name }, mode: 'Individual' }) });
      if (!response.ok) throw new Error(`Product Selection ${item.key} creation failed (HTTP ${response.status})`);
      selection = selectionSchema.parse(await response.json()); selectionsCreated++;
    } else {
      if (!response.ok) throw new Error(`Product Selection ${item.key} lookup failed (HTTP ${response.status})`);
      selection = selectionSchema.parse(await response.json()); selectionsReused++;
    }
    const assignmentResponse = await request(`/product-selections/${encodeURIComponent(selection.id)}`, { method: 'POST', body: JSON.stringify({ version: selection.version, actions: item.productKeys.map(productKey => ({ action: 'addProduct', product: { typeId: 'product', key: productKey } })) }) });
    if (!assignmentResponse.ok) throw new Error(`Product assignments for ${item.key} failed (HTTP ${assignmentResponse.status})`);
    selection = selectionSchema.parse(await assignmentResponse.json());
    if (selection.productCount !== item.productKeys.length) throw new Error(`Product Selection ${item.key} has unexpected product count ${selection.productCount}`);
    productAssignmentsApplied += item.productKeys.length;
    const storeResponse = await request(`/stores/key=${encodeURIComponent(item.storeKey)}`);
    if (!storeResponse.ok) throw new Error(`Store ${item.storeKey} was not found (HTTP ${storeResponse.status})`);
    const store = storeSchema.parse(await storeResponse.json());
    const existing = store.productSelections.find(setting => setting.productSelection.id === selection.id);
    if (existing?.active) { storesAlreadyActive++; continue; }
    const action = existing ? { action: 'changeProductSelectionActive', productSelection: { typeId: 'product-selection', id: selection.id }, active: true } : { action: 'addProductSelection', productSelection: { typeId: 'product-selection', id: selection.id }, active: true };
    const updatedStore = await request(`/stores/${encodeURIComponent(store.id)}`, { method: 'POST', body: JSON.stringify({ version: store.version, actions: [action] }) });
    if (!updatedStore.ok) throw new Error(`Store ${item.storeKey} activation failed (HTTP ${updatedStore.status})`);
    storeSchema.parse(await updatedStore.json()); storesActivated++;
  }
  console.log(JSON.stringify({ mode: 'apply', selectionsCreated, selectionsReused, productAssignmentsApplied, storesActivated, storesAlreadyActive }, null, 2));
}

main().catch(error => { console.error(error instanceof Error && /^(Authentication|Required Product|Product Selection|Product assignments|Store )/.test(error.message) ? error.message : 'Product Selection import failed'); process.exitCode = 1; });
