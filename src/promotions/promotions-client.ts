import { z } from 'zod';
import type { Config } from '../config.js';
import { CommerceError } from '../commercetools.js';
import type { CreatePromotionInput, PromotionService } from './promotions.js';

const localizedString = z.record(z.string(), z.string());
const money = z.object({ currencyCode: z.string(), centAmount: z.number().int() });
const discountValue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('relative'), permyriad: z.number().int() }),
  z.object({ type: z.literal('absolute'), money: z.array(money) }),
]);
const productDiscount = z.object({
  id: z.string(),
  key: z.string().optional(),
  name: localizedString,
  value: discountValue,
  predicate: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
});

export class CommercetoolsPromotionClient implements PromotionService {
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;

  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = this.fetchToken();
    try { return await this.pendingToken; }
    finally { this.pendingToken = undefined; }
  }

  private async fetchToken(): Promise<string> {
    const response = await this.fetcher(`${this.config.CT_AUTH_URL.replace(/\/$/, '')}/oauth/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.CT_CLIENT_ID}:${this.config.CT_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.config.CT_SCOPES }),
    });
    if (!response.ok) throw new CommerceError(502, 'CommerceAuthenticationFailed', 'Unable to authenticate with commerce service');
    const result = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).parse(await response.json());
    this.token = { value: result.access_token, expiresAt: Date.now() + Math.max(0, result.expires_in - 60) * 1000 };
    return result.access_token;
  }

  private async commerce(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(`${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  }

  async listPromotions() {
    const response = await this.commerce('/product-discounts?sort=createdAt%20desc&limit=100');
    if (!response.ok) throw new CommerceError(502, 'PromotionListFailed', 'Unable to load product promotions');
    const result = z.object({ results: z.array(productDiscount) }).parse(await response.json());
    return {
      promotions: result.results.map(discount => ({
        id: discount.id,
        key: discount.key,
        name: discount.name['en-CA'] ?? discount.name.en ?? Object.values(discount.name)[0] ?? discount.id,
        predicate: discount.predicate,
        active: discount.isActive,
        discount: discount.value.type === 'relative'
          ? { type: 'percentage', value: discount.value.permyriad / 100 }
          : { type: 'fixed', value: (discount.value.money.find(value => value.currencyCode === 'CAD')?.centAmount ?? 0) / 100 },
        createdAt: discount.createdAt,
      })),
    };
  }

  async createPromotion(input: CreatePromotionInput) {
    const productResponse = await this.commerce(`/product-projections?${new URLSearchParams({
      where: `masterVariant(sku=\"${input.sku}\") or variants(sku=\"${input.sku}\")`, limit: '1',
    })}`);
    if (!productResponse.ok) throw new CommerceError(502, 'ProductLookupFailed', 'Unable to verify the SKU');
    const productResult = z.object({ total: z.number().int() }).parse(await productResponse.json());
    if (productResult.total < 1) throw new CommerceError(404, 'SkuNotFound', `No published product was found for SKU ${input.sku}`);

    const percentage = input.discountType === 'percentage';
    if (percentage && input.discount > 100) throw new CommerceError(400, 'InvalidDiscount', 'Percentage discount cannot exceed 100');
    const suffix = Date.now().toString();
    const keySku = input.sku.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80);
    const body = {
      key: `bff-${keySku}-${suffix}`.slice(0, 256),
      name: { 'en-CA': input.name, en: input.name },
      description: { 'en-CA': `Created from the BFF promotion dashboard for SKU ${input.sku}` },
      value: percentage
        ? { type: 'relative', permyriad: Math.round(input.discount * 100) }
        : { type: 'absolute', money: [{ currencyCode: 'CAD', centAmount: Math.round(input.discount * 100) }] },
      predicate: `sku = \"${input.sku}\"`,
      sortOrder: `0.${suffix.slice(-12)}`,
      isActive: true,
    };
    const response = await this.commerce('/product-discounts', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) {
      let message = 'commercetools rejected the product discount';
      try {
        const error = z.object({ message: z.string().optional() }).parse(await response.json());
        if (error.message) message = error.message;
      } catch { /* use safe fallback */ }
      throw new CommerceError(response.status === 400 ? 400 : 502, 'PromotionCreationFailed', message);
    }
    const created = productDiscount.parse(await response.json());
    return { promotion: { id: created.id, key: created.key, name: input.name, sku: input.sku, active: created.isActive } };
  }

  async removePromotion(id: string) {
    const currentResponse = await this.commerce(`/product-discounts/${encodeURIComponent(id)}`);
    if (currentResponse.status === 404) throw new CommerceError(404, 'PromotionNotFound', 'Product discount was not found');
    if (!currentResponse.ok) throw new CommerceError(502, 'PromotionReadFailed', 'Unable to read the product discount');
    const current = z.object({ id: z.string(), version: z.number().int().positive() }).parse(await currentResponse.json());
    const response = await this.commerce(`/product-discounts/${encodeURIComponent(id)}?version=${current.version}`, { method: 'DELETE' });
    if (response.status === 404) throw new CommerceError(404, 'PromotionNotFound', 'Product discount was not found');
    if (response.status === 409) throw new CommerceError(409, 'PromotionChanged', 'Product discount changed; refresh and try again');
    if (!response.ok) throw new CommerceError(502, 'PromotionRemovalFailed', 'Unable to remove the product discount');
    return { removed: true, id };
  }
}
