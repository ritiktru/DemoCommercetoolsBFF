import { z } from 'zod';
import { loadStoreImportConfig } from '../stores/store-importer.js';

const key = z.string().min(2).max(256).regex(/^[A-Za-z0-9_-]+$/);
const priceSchema = z.object({ storeId: z.string().regex(/^\d+$/), centAmount: z.number().int().nonnegative(), currencyCode: z.literal('CAD') });
const productSchema = z.object({
  key, name: z.string().min(1), slug: z.string().min(1), description: z.string().min(1), sku: z.string().min(1),
  categoryKey: key, attributes: z.record(z.string(), z.unknown()), images: z.array(z.url()), prices: z.array(priceSchema).min(1),
});
export const productManifestSchema = z.object({
  schemaVersion: z.literal(1), source: z.string().min(1), productTypeKey: key, products: z.array(productSchema).min(1),
}).superRefine((data, ctx) => {
  const keys = new Set<string>(); const skus = new Set<string>();
  for (const [index, product] of data.products.entries()) {
    if (keys.has(product.key)) ctx.addIssue({ code: 'custom', message: 'Duplicate product key', path: ['products', index, 'key'] });
    if (skus.has(product.sku)) ctx.addIssue({ code: 'custom', message: 'Duplicate SKU', path: ['products', index, 'sku'] });
    keys.add(product.key); skus.add(product.sku);
    const stores = new Set<string>();
    for (const [priceIndex, price] of product.prices.entries()) {
      if (stores.has(price.storeId)) ctx.addIssue({ code: 'custom', message: 'Duplicate store price', path: ['products', index, 'prices', priceIndex, 'storeId'] });
      stores.add(price.storeId);
    }
  }
});
export type ProductManifest = z.infer<typeof productManifestSchema>;
type Config = ReturnType<typeof loadStoreImportConfig>;
type Status = 'created' | 'unchanged';
type Result = { products: Record<Status, number>; pricesCreated: number; deferredPrices: Array<{ productKey: string; storeId: string; reason: string }>; deferredImages: Array<{ productKey: string; count: number; reason: string }> };

const productResponse = z.object({
  id: z.string(), version: z.number(), key,
  masterData: z.object({
    published: z.boolean(),
    current: z.object({ masterVariant: z.object({ sku: z.string().optional(), prices: z.array(z.unknown()).optional() }) }).optional(),
    staged: z.object({ masterVariant: z.object({ sku: z.string().optional(), prices: z.array(z.unknown()).optional() }) }),
  }),
});

export class ProductImporter {
  private token = '';
  private readonly base: string;
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {
    this.base = `${config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(config.CT_PROJECT_KEY)}`;
  }

  private async authenticate(): Promise<void> {
    const response = await this.fetcher(`${this.config.CT_AUTH_URL.replace(/\/$/, '')}/oauth/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Basic ${Buffer.from(`${this.config.CT_CLIENT_ID}:${this.config.CT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.config.CT_SCOPES }),
    });
    if (!response.ok) throw new Error(`Importer authentication failed (HTTP ${response.status})`);
    this.token = z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.fetcher(`${this.base}${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${this.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
      if (response.status !== 429 || attempt === 3) return response;
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw new Error('Unexpected retry state');
  }

  private async requireReference(kind: 'product-types' | 'categories', referenceKey: string): Promise<void> {
    const response = await this.request(`/${kind}/key=${encodeURIComponent(referenceKey)}`);
    if (!response.ok) throw new Error(`Required ${kind === 'product-types' ? 'Product Type' : 'Category'} ${referenceKey} was not found (HTTP ${response.status})`);
  }

  private async availableStores(manifest: ProductManifest): Promise<Set<string>> {
    const stores = [...new Set(manifest.products.flatMap(product => product.prices.map(price => price.storeId)))];
    const available = new Set<string>();
    for (const storeId of stores) {
      const response = await this.request(`/channels/key=${encodeURIComponent(`sobeys-${storeId}-channel`)}`);
      if (response.ok) available.add(storeId);
      else if (response.status !== 404) throw new Error(`Channel lookup failed for store ${storeId} (HTTP ${response.status})`);
    }
    return available;
  }

  async apply(source: ProductManifest): Promise<Result> {
    const manifest = productManifestSchema.parse(source);
    await this.authenticate();
    await this.requireReference('product-types', manifest.productTypeKey);
    for (const categoryKey of new Set(manifest.products.map(product => product.categoryKey))) await this.requireReference('categories', categoryKey);
    const available = await this.availableStores(manifest);
    const result: Result = { products: { created: 0, unchanged: 0 }, pricesCreated: 0, deferredPrices: [], deferredImages: [] };
    for (const product of manifest.products) {
      const applicablePrices = product.prices.filter(price => available.has(price.storeId));
      for (const price of product.prices.filter(price => !available.has(price.storeId))) {
        result.deferredPrices.push({ productKey: product.key, storeId: price.storeId, reason: 'Store Channel not found' });
      }
      if (product.images.length) result.deferredImages.push({ productKey: product.key, count: product.images.length, reason: 'PACE export has URLs but no dimensions required by commercetools' });
      const existing = await this.request(`/products/key=${encodeURIComponent(product.key)}`);
      if (existing.ok) {
        const parsed = productResponse.parse(await existing.json());
        const projection = parsed.masterData.current ?? parsed.masterData.staged;
        if (projection.masterVariant.sku !== product.sku || !parsed.masterData.published) throw new Error(`Existing Product ${product.key} differs from the reviewed POC identity or is unpublished`);
        result.products.unchanged++;
        continue;
      }
      if (existing.status !== 404) throw new Error(`Product ${product.key} lookup failed (HTTP ${existing.status})`);
      const draft = {
        key: product.key, productType: { typeId: 'product-type', key: manifest.productTypeKey },
        name: { 'en-CA': product.name }, slug: { 'en-CA': product.slug }, description: { 'en-CA': product.description },
        categories: [{ typeId: 'category', key: product.categoryKey }], publish: true,
        masterVariant: {
          sku: product.sku,
          attributes: Object.entries(product.attributes).map(([name, value]) => ({ name, value })),
          prices: applicablePrices.map(price => ({
            value: { currencyCode: price.currencyCode, centAmount: price.centAmount }, country: 'CA',
            channel: { typeId: 'channel', key: `sobeys-${price.storeId}-channel` },
          })),
        },
      };
      const created = await this.request('/products', { method: 'POST', body: JSON.stringify(draft) });
      if (!created.ok) {
        let codes: string[] = [];
        try {
          const body = z.object({ errors: z.array(z.object({ code: z.string() }).passthrough()) }).safeParse(await created.json());
          if (body.success) codes = body.data.errors.map(error => error.code);
        } catch { /* sanitized below */ }
        throw new Error(`Product ${product.key} creation failed (HTTP ${created.status}${codes.length ? `; ${codes.join(', ')}` : ''})`);
      }
      const parsed = productResponse.parse(await created.json());
      if (!parsed.masterData.published || parsed.masterData.current?.masterVariant.sku !== product.sku) throw new Error(`Product ${product.key} was created but publish verification failed`);
      result.products.created++;
      result.pricesCreated += applicablePrices.length;
    }
    return result;
  }
}
