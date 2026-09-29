import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { loadStoreImportConfig } from '../src/stores/store-importer.js';
import { productManifestSchema } from '../src/catalog/product-importer.js';

const mappingSchema = z.object({
  purpose: z.string(), seed: z.number().int(),
  mapping: z.record(z.string(), z.object({ mappedStoreNumber: z.string(), mappedStoreName: z.string(), channelKey: z.string() })),
});
const resourceSchema = z.object({ id: z.string(), version: z.number().int(), key: z.string() });
const productSchema = z.object({
  id: z.string(), version: z.number().int(), key: z.string(), masterData: z.object({
    published: z.boolean(), current: z.object({ masterVariant: z.object({ prices: z.array(z.object({ value: z.object({ currencyCode: z.string(), centAmount: z.number() }), country: z.string().optional(), channel: z.object({ id: z.string() }).optional() })) }) }).optional(),
    staged: z.object({ masterVariant: z.object({ prices: z.array(z.object({ value: z.object({ currencyCode: z.string(), centAmount: z.number() }), country: z.string().optional(), channel: z.object({ id: z.string() }).optional() })) }) }),
  }),
});

async function main() {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !['--dry-run', '--apply'].includes(mode))) throw new Error('Usage: npm run catalog:poc-prices -- [--dry-run|--apply]');
  const manifest = productManifestSchema.parse(JSON.parse(await readFile(new URL('../imports/pace-products-poc.json', import.meta.url), 'utf8')));
  const mapping = mappingSchema.parse(JSON.parse(await readFile(new URL('../imports/pace-price-store-poc-mapping.json', import.meta.url), 'utf8')));
  const rows = manifest.products.flatMap(product => product.prices.filter(price => mapping.mapping[price.storeId]).map(price => ({ productKey: product.key, sourceStoreId: price.storeId, mappedStoreId: mapping.mapping[price.storeId]!.mappedStoreNumber, mappedStoreName: mapping.mapping[price.storeId]!.mappedStoreName, channelKey: mapping.mapping[price.storeId]!.channelKey, centAmount: price.centAmount })));
  if (mode !== '--apply') {
    console.log(JSON.stringify({ mode: 'dry-run', seed: mapping.seed, prices: rows.length, rows, message: 'POC mapping validated locally. No network requests or commercetools writes.' }, null, 2));
    return;
  }
  const config = loadStoreImportConfig(process.env);
  const tokenResponse = await fetch(`${config.CT_AUTH_URL.replace(/\/$/, '')}/oauth/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Basic ${Buffer.from(`${config.CT_CLIENT_ID}:${config.CT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: config.CT_SCOPES }) });
  if (!tokenResponse.ok) throw new Error(`Authentication failed (HTTP ${tokenResponse.status})`);
  const token = z.object({ access_token: z.string() }).parse(await tokenResponse.json()).access_token;
  const base = `${config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(config.CT_PROJECT_KEY)}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const channels = new Map<string, z.infer<typeof resourceSchema>>();
  for (const row of rows) {
    if (channels.has(row.channelKey)) continue;
    const response = await request(`/channels/key=${encodeURIComponent(row.channelKey)}`);
    if (!response.ok) throw new Error(`Mapped Channel ${row.channelKey} was not found (HTTP ${response.status})`);
    channels.set(row.channelKey, resourceSchema.parse(await response.json()));
  }
  let created = 0; let unchanged = 0;
  for (const productKey of [...new Set(rows.map(row => row.productKey))]) {
    const response = await request(`/products/key=${encodeURIComponent(productKey)}`);
    if (!response.ok) throw new Error(`Product ${productKey} was not found (HTTP ${response.status})`);
    let product = productSchema.parse(await response.json());
    const actions: object[] = [];
    for (const row of rows.filter(item => item.productKey === productKey)) {
      const channel = channels.get(row.channelKey)!;
      const allPrices = [...product.masterData.staged.masterVariant.prices, ...(product.masterData.current?.masterVariant.prices ?? [])];
      const existing = allPrices.find(price => price.channel?.id === channel.id && price.value.currencyCode === 'CAD' && price.country === 'CA');
      if (existing) {
        if (existing.value.centAmount !== row.centAmount) throw new Error(`Product ${productKey} already has a different POC price in ${row.channelKey}`);
        unchanged++; continue;
      }
      actions.push({ action: 'addPrice', sku: `${productKey}-EA`, price: { value: { currencyCode: 'CAD', centAmount: row.centAmount }, country: 'CA', channel: { typeId: 'channel', id: channel.id } } });
      created++;
    }
    if (actions.length) {
      const updated = await request(`/products/${encodeURIComponent(product.id)}`, { method: 'POST', body: JSON.stringify({ version: product.version, actions }) });
      if (!updated.ok) throw new Error(`Product ${productKey} price update failed (HTTP ${updated.status})`);
      product = productSchema.parse(await updated.json());
    }
    const stagedChannels = new Set(product.masterData.staged.masterVariant.prices.map(price => price.channel?.id));
    const currentChannels = new Set((product.masterData.current?.masterVariant.prices ?? []).map(price => price.channel?.id));
    if ([...stagedChannels].some(id => !currentChannels.has(id))) {
      const published = await request(`/products/${encodeURIComponent(product.id)}`, { method: 'POST', body: JSON.stringify({ version: product.version, actions: [{ action: 'publish' }] }) });
      if (!published.ok) throw new Error(`Product ${productKey} publish failed (HTTP ${published.status})`);
      productSchema.parse(await published.json());
    }
  }
  console.log(JSON.stringify({ mode: 'apply', seed: mapping.seed, pricesCreated: created, pricesUnchanged: unchanged, mapping: mapping.mapping }, null, 2));
}

main().catch(error => { console.error(error instanceof Error && /^(Authentication|Mapped Channel|Product )/.test(error.message) ? error.message : 'POC price mapping failed'); process.exitCode = 1; });
