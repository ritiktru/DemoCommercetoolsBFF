import { z } from 'zod';
import type { Config } from '../config.js';
import { CommerceError } from '../commercetools.js';
import type { CreateBundlePromotionInput, CreateCustomerGroupPromotionInput, CreatePromotionInput, PromotionService } from './promotions.js';

const localizedString = z.record(z.string(), z.string());
const money = z.object({ currencyCode: z.string(), centAmount: z.number().int() });
const discountValue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('relative'), permyriad: z.number().int() }),
  z.object({ type: z.literal('absolute'), money: z.array(money) }),
  z.object({ type: z.literal('fixed'), money: z.array(money) }),
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
const cartDiscount = z.object({
  id: z.string(), key: z.string().optional(), name: localizedString,
  value: discountValue, cartPredicate: z.string(), target: z.object({ type: z.string() }).passthrough(),
  isActive: z.boolean(), createdAt: z.string(),
});
const patternTarget = z.object({
  type: z.literal('pattern'),
  triggerPattern: z.array(z.object({ type: z.string(), predicate: z.string(), minCount: z.number().int().optional(), maxCount: z.number().int().optional() })),
  targetPattern: z.array(z.object({ type: z.string(), predicate: z.string(), minCount: z.number().int().optional(), maxCount: z.number().int().optional() })),
  maxOccurrence: z.number().int().optional(),
  selectionMode: z.string(),
});
const customerGroupCartPredicate = (customerGroupId: string) =>
  `(customer.customerGroup.id = \"${customerGroupId}\" or customer.customerGroupAssignments.customerGroup.id contains \"${customerGroupId}\")`;

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
    const [productResponse, cartResponse] = await Promise.all([
      this.commerce('/product-discounts?sort=createdAt%20desc&limit=100'),
      this.commerce('/cart-discounts?sort=createdAt%20desc&limit=100'),
    ]);
    if (!productResponse.ok || !cartResponse.ok) throw new CommerceError(502, 'PromotionListFailed', 'Unable to load product promotions');
    const result = z.object({ results: z.array(productDiscount) }).parse(await productResponse.json());
    const cartResult = z.object({ results: z.array(cartDiscount) }).parse(await cartResponse.json());
    const singleProductCartPromotions = cartResult.results.filter(discount =>
      (discount.key?.startsWith('bff-final-price-') && discount.target.type === 'lineItems' && discount.value.type === 'fixed') ||
      (discount.key?.startsWith('bff-bogo-') && discount.target.type === 'pattern' && discount.value.type === 'relative') ||
      (discount.key?.startsWith('bff-product-group-') && discount.target.type === 'lineItems'));
    return {
      promotions: [...result.results.map(discount => ({
        id: discount.id,
        resourceType: 'product-discount' as const,
        key: discount.key,
        name: discount.name['en-CA'] ?? discount.name.en ?? Object.values(discount.name)[0] ?? discount.id,
        predicate: discount.predicate,
        active: discount.isActive,
      discount: discount.value.type === 'relative'
          ? { type: 'percentage', value: discount.value.permyriad / 100 }
          : { type: 'fixed', value: (discount.value.money.find(value => value.currencyCode === 'CAD')?.centAmount ?? 0) / 100 },
        createdAt: discount.createdAt,
      })), ...singleProductCartPromotions.map(discount => {
        const bogo = discount.key?.startsWith('bff-bogo-');
        const groupProduct = discount.key?.startsWith('bff-product-group-');
        const target = bogo ? patternTarget.safeParse(discount.target) : undefined;
        const trigger = target?.success ? target.data.triggerPattern[0] : undefined;
        const reward = target?.success ? target.data.targetPattern[0] : undefined;
        return {
        id: discount.id,
        resourceType: 'cart-discount' as const,
        key: discount.key,
        name: discount.name['en-CA'] ?? discount.name.en ?? Object.values(discount.name)[0] ?? discount.id,
        predicate: bogo ? (trigger?.predicate ?? '') : ('predicate' in discount.target && typeof discount.target.predicate === 'string' ? discount.target.predicate : ''),
        active: discount.isActive,
        customerGroupId: discount.cartPredicate.match(/contains\s+\"([^\"]+)\"/)?.[1],
        discount: bogo
          ? { type: 'bogo', value: 100, buyQuantity: trigger?.maxCount ?? trigger?.minCount ?? 1, freeQuantity: reward?.maxCount ?? reward?.minCount ?? 1, repeat: !target?.success || target.data.maxOccurrence === undefined }
          : groupProduct
            ? discount.value.type === 'relative'
              ? { type: 'percentage', value: discount.value.permyriad / 100 }
              : { type: 'fixed', value: (discount.value.type === 'absolute' ? discount.value.money.find(value => value.currencyCode === 'CAD')?.centAmount : 0) ?? 0 }
            : { type: 'finalPrice', value: (discount.value.type === 'fixed' ? discount.value.money.find(value => value.currencyCode === 'CAD')?.centAmount : 0) ?? 0 },
        createdAt: discount.createdAt,
      }; }).map(discount => discount.discount.type === 'finalPrice' || (discount.key?.startsWith('bff-product-group-') && discount.discount.type === 'fixed')
        ? { ...discount, discount: { ...discount.discount, value: discount.discount.value / 100 } }
        : discount)]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
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
    const discountAmount = input.discount ?? 0;
    if (percentage && discountAmount > 100) throw new CommerceError(400, 'InvalidDiscount', 'Percentage discount cannot exceed 100');
    const suffix = Date.now().toString();
    const keySku = input.sku.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80);
    if (input.customerGroupId) await this.verifyCustomerGroup(input.customerGroupId);
    const cartPredicate = input.customerGroupId
      ? customerGroupCartPredicate(input.customerGroupId)
      : '1 = 1';
    const common = {
      key: `bff-${keySku}-${suffix}`.slice(0, 256),
      name: { 'en-CA': input.name, en: input.name },
      description: { 'en-CA': `Created from the BFF promotion dashboard for SKU ${input.sku}` },
    };
    if (input.discountType === 'bogo') {
      const predicate = `sku = \"${input.sku}\"`;
      const body = {
        ...common,
        key: `bff-bogo-${keySku}-${suffix}`.slice(0, 256),
        description: { 'en-CA': `Buy ${input.buyQuantity} and get ${input.freeQuantity} free for SKU ${input.sku}` },
        value: { type: 'relative', permyriad: 10000, applicationMode: 'IndividualApplication' },
        cartPredicate,
        target: {
          type: 'pattern',
          triggerPattern: [{ type: 'CountOnLineItemUnits', predicate, minCount: input.buyQuantity, maxCount: input.buyQuantity }],
          targetPattern: [{ type: 'CountOnLineItemUnits', predicate, minCount: input.freeQuantity, maxCount: input.freeQuantity }],
          ...(input.repeat === false ? { maxOccurrence: 1 } : {}),
          selectionMode: 'Cheapest',
        },
        sortOrder: `0.${suffix.slice(-12)}`,
        isActive: true,
        requiresDiscountCode: false,
        stackingMode: 'Stacking',
      };
      const response = await this.commerce('/cart-discounts', { method: 'POST', body: JSON.stringify(body) });
      if (!response.ok) throw new CommerceError(response.status === 400 ? 400 : 502, 'PromotionCreationFailed', await this.commerceErrorMessage(response, 'commercetools rejected the buy-and-get discount'));
      const created = cartDiscount.parse(await response.json());
      return { promotion: { id: created.id, resourceType: 'cart-discount', key: created.key, name: input.name, sku: input.sku, active: created.isActive } };
    }
    if (input.discountType === 'finalPrice') {
      const body = {
        ...common,
        key: `bff-final-price-${keySku}-${suffix}`.slice(0, 256),
        value: { type: 'fixed', money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: Math.round(discountAmount * 100), fractionDigits: 2 }], applicationMode: 'IndividualApplication' },
        cartPredicate,
        target: { type: 'lineItems', predicate: `sku = \"${input.sku}\"` },
        sortOrder: `0.${suffix.slice(-12)}`,
        isActive: true,
        requiresDiscountCode: false,
        stackingMode: 'Stacking',
      };
      const response = await this.commerce('/cart-discounts', { method: 'POST', body: JSON.stringify(body) });
      if (!response.ok) throw new CommerceError(response.status === 400 ? 400 : 502, 'PromotionCreationFailed', await this.commerceErrorMessage(response, 'commercetools rejected the final-price discount'));
      const created = cartDiscount.parse(await response.json());
      return { promotion: { id: created.id, resourceType: 'cart-discount', key: created.key, name: input.name, sku: input.sku, active: created.isActive } };
    }
    const body = {
      ...common,
      value: percentage
        ? { type: 'relative', permyriad: Math.round(discountAmount * 100) }
        : { type: 'absolute', money: [{ currencyCode: 'CAD', centAmount: Math.round(discountAmount * 100) }] },
      predicate: `sku = \"${input.sku}\"`,
      sortOrder: `0.${suffix.slice(-12)}`,
      isActive: true,
    };
    if (input.customerGroupId) {
      const cartBody = {
        ...common,
        key: `bff-product-group-${keySku}-${suffix}`.slice(0, 256),
        value: percentage
          ? { type: 'relative', permyriad: Math.round(discountAmount * 100), applicationMode: 'IndividualApplication' }
          : { type: 'absolute', money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: Math.round(discountAmount * 100), fractionDigits: 2 }], applicationMode: 'IndividualApplication' },
        cartPredicate,
        target: { type: 'lineItems', predicate: `sku = \"${input.sku}\"` },
        sortOrder: `0.${suffix.slice(-12)}`,
        isActive: true, requiresDiscountCode: false, stackingMode: 'Stacking',
      };
      const response = await this.commerce('/cart-discounts', { method: 'POST', body: JSON.stringify(cartBody) });
      if (!response.ok) throw new CommerceError(response.status === 400 ? 400 : 502, 'PromotionCreationFailed', await this.commerceErrorMessage(response, 'commercetools rejected the customer-group product discount'));
      const created = cartDiscount.parse(await response.json());
      return { promotion: { id: created.id, resourceType: 'cart-discount', key: created.key, name: input.name, sku: input.sku, active: created.isActive } };
    }
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

  private async commerceErrorMessage(response: Response, fallback: string) {
    try {
      const error = z.object({ message: z.string().optional() }).parse(await response.json());
      return error.message ?? fallback;
    } catch { return fallback; }
  }

  async listCustomerGroups() {
    const response = await this.commerce('/customer-groups?sort=name%20asc&limit=500');
    if (!response.ok) throw new CommerceError(502, 'CustomerGroupListFailed', 'Unable to load customer groups');
    const result = z.object({ results: z.array(z.object({ id: z.string(), key: z.string().optional(), name: z.string() })) }).parse(await response.json());
    return { groups: result.results };
  }

  private async verifyCustomerGroup(customerGroupId: string) {
    const response = await this.commerce(`/customer-groups/${encodeURIComponent(customerGroupId)}`);
    if (response.status === 404) throw new CommerceError(404, 'CustomerGroupNotFound', 'Customer group was not found');
    if (!response.ok) throw new CommerceError(502, 'CustomerGroupLookupFailed', 'Unable to verify the customer group');
  }

  async listCustomerGroupPromotions() {
    const response = await this.commerce('/cart-discounts?sort=createdAt%20desc&limit=500');
    if (!response.ok) throw new CommerceError(502, 'PromotionListFailed', 'Unable to load customer group promotions');
    const result = z.object({ results: z.array(cartDiscount) }).parse(await response.json());
    return { promotions: result.results.filter(discount => discount.key?.startsWith('bff-customer-group-')).map(discount => ({
      id: discount.id, key: discount.key,
      name: discount.name['en-CA'] ?? discount.name.en ?? Object.values(discount.name)[0] ?? discount.id,
      customerGroupId: discount.cartPredicate.match(/contains\s+\"([^\"]+)\"/)?.[1],
      active: discount.isActive,
      discount: discount.value.type === 'relative'
        ? { type: 'percentage', value: discount.value.permyriad / 100 }
        : { type: 'fixed', value: (discount.value.money.find(amount => amount.currencyCode === 'CAD')?.centAmount ?? 0) / 100 },
      createdAt: discount.createdAt,
    })) };
  }

  async createCustomerGroupPromotion(input: CreateCustomerGroupPromotionInput) {
    const groupResponse = await this.commerce(`/customer-groups/${encodeURIComponent(input.customerGroupId)}`);
    if (groupResponse.status === 404) throw new CommerceError(404, 'CustomerGroupNotFound', 'Customer group was not found');
    if (!groupResponse.ok) throw new CommerceError(502, 'CustomerGroupLookupFailed', 'Unable to verify the customer group');
    const group = z.object({ id: z.string(), name: z.string() }).parse(await groupResponse.json());
    if (input.discountType === 'percentage' && input.discount > 100) throw new CommerceError(400, 'InvalidDiscount', 'Percentage discount cannot exceed 100');
    const suffix = Date.now().toString();
    const body = {
      key: `bff-customer-group-${input.customerGroupId}-${suffix}`.slice(0, 256),
      name: { 'en-CA': input.name, en: input.name },
      description: { 'en-CA': `${input.discount}${input.discountType === 'percentage' ? '%' : ' CAD'} off all products for ${group.name}` },
      value: input.discountType === 'percentage'
        ? { type: 'relative', permyriad: Math.round(input.discount * 100) }
        : { type: 'absolute', money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: Math.round(input.discount * 100), fractionDigits: 2 }], applicationMode: 'IndividualApplication' },
      cartPredicate: customerGroupCartPredicate(input.customerGroupId),
      target: { type: 'lineItems', predicate: 'true' },
      sortOrder: `0.${suffix.slice(-12)}`,
      isActive: true, requiresDiscountCode: false, stackingMode: 'Stacking',
    };
    const response = await this.commerce('/cart-discounts', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new CommerceError(response.status === 400 ? 400 : 502, 'PromotionCreationFailed', await this.commerceErrorMessage(response, 'commercetools rejected the customer group promotion'));
    const created = cartDiscount.parse(await response.json());
    return { promotion: { id: created.id, key: created.key, name: input.name, customerGroupId: input.customerGroupId, active: created.isActive } };
  }

  async removePromotion(id: string, resourceType: 'product-discount' | 'cart-discount' = 'product-discount') {
    const collection = resourceType === 'cart-discount' ? 'cart-discounts' : 'product-discounts';
    const currentResponse = await this.commerce(`/${collection}/${encodeURIComponent(id)}`);
    if (currentResponse.status === 404) throw new CommerceError(404, 'PromotionNotFound', 'Discount was not found');
    if (!currentResponse.ok) throw new CommerceError(502, 'PromotionReadFailed', 'Unable to read the discount');
    const current = z.object({ id: z.string(), version: z.number().int().positive() }).parse(await currentResponse.json());
    const response = await this.commerce(`/${collection}/${encodeURIComponent(id)}?version=${current.version}`, { method: 'DELETE' });
    if (response.status === 404) throw new CommerceError(404, 'PromotionNotFound', 'Discount was not found');
    if (response.status === 409) throw new CommerceError(409, 'PromotionChanged', 'Discount changed; refresh and try again');
    if (!response.ok) throw new CommerceError(502, 'PromotionRemovalFailed', 'Unable to remove the discount');
    return { removed: true, id };
  }

  async listBundlePromotions() {
    const response = await this.commerce('/cart-discounts?sort=createdAt%20desc&limit=100');
    if (!response.ok) throw new CommerceError(502, 'BundlePromotionListFailed', 'Unable to load bundle promotions');
    const result = z.object({ results: z.array(cartDiscount) }).parse(await response.json());
    return { promotions: result.results.filter(discount => discount.target.type === 'pattern').map(discount => ({
      id: discount.id,
      key: discount.key,
      name: discount.name['en-CA'] ?? discount.name.en ?? Object.values(discount.name)[0] ?? discount.id,
      customerGroupId: discount.cartPredicate.match(/contains\s+\"([^\"]+)\"/)?.[1],
      active: discount.isActive,
      discount: discount.value.type === 'relative'
        ? { type: 'percentage', value: discount.value.permyriad / 100 }
        : { type: discount.value.type === 'absolute' ? 'amountOff' : 'fixedBundlePrice', value: (discount.value.money.find(value => value.currencyCode === 'CAD')?.centAmount ?? 0) / 100 },
      target: discount.target,
      createdAt: discount.createdAt,
    })) };
  }

  private async verifySkus(skus: string[]) {
    const missing: string[] = [];
    for (const sku of skus) {
      const response = await this.commerce(`/product-projections?${new URLSearchParams({
        where: `masterVariant(sku=\"${sku}\") or variants(sku=\"${sku}\")`, limit: '1',
      })}`);
      if (!response.ok) throw new CommerceError(502, 'ProductLookupFailed', `Unable to verify SKU ${sku}`);
      const result = z.object({ total: z.number().int() }).parse(await response.json());
      if (result.total < 1) missing.push(sku);
    }
    if (missing.length) throw new CommerceError(404, 'SkuNotFound', `No published product was found for: ${missing.join(', ')}`);
  }

  async createBundlePromotion(input: CreateBundlePromotionInput) {
    await this.verifySkus(input.skus);
    if (input.customerGroupId) await this.verifyCustomerGroup(input.customerGroupId);
    if (input.promotionType === 'percentageOff' && input.discount > 100) {
      throw new CommerceError(400, 'InvalidDiscount', 'Percentage discount cannot exceed 100');
    }
    const suffix = Date.now().toString();
    const predicate = `sku in (${input.skus.map(sku => `\"${sku}\"`).join(', ')})`;
    const body = {
      key: `bff-bundle-${suffix}`,
      name: { 'en-CA': input.name, en: input.name },
      description: { 'en-CA': `${input.quantity} qualifying items from ${input.skus.length} SKUs` },
      value: input.promotionType === 'percentageOff'
        ? { type: 'relative', permyriad: Math.round(input.discount * 100), applicationMode: 'IndividualApplication' }
        : input.promotionType === 'amountOff'
          ? { type: 'absolute', money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: Math.round(input.discount * 100), fractionDigits: 2 }], applicationMode: 'EvenDistribution' }
          : { type: 'fixed', money: [{ type: 'centPrecision', currencyCode: 'CAD', centAmount: Math.round(input.discount * 100), fractionDigits: 2 }], applicationMode: 'EvenDistribution' },
      cartPredicate: input.customerGroupId
        ? customerGroupCartPredicate(input.customerGroupId)
        : '1 = 1',
      target: {
        type: 'pattern', triggerPattern: [],
        targetPattern: [{ type: 'CountOnLineItemUnits', predicate, minCount: input.quantity, maxCount: input.quantity }],
        ...(input.repeat ? {} : { maxOccurrence: 1 }), selectionMode: 'Cheapest',
      },
      sortOrder: `0.${suffix.slice(-12)}`,
      isActive: true, requiresDiscountCode: false, stackingMode: 'Stacking',
    };
    const response = await this.commerce('/cart-discounts', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) {
      let message = 'commercetools rejected the bundle promotion';
      try { const error = z.object({ message: z.string().optional() }).parse(await response.json()); if (error.message) message = error.message; } catch { /* safe fallback */ }
      throw new CommerceError(response.status === 400 ? 400 : 502, 'BundlePromotionCreationFailed', message);
    }
    const created = cartDiscount.parse(await response.json());
    return { promotion: { id: created.id, key: created.key, name: input.name, active: created.isActive } };
  }

  async removeBundlePromotion(id: string) {
    const currentResponse = await this.commerce(`/cart-discounts/${encodeURIComponent(id)}`);
    if (currentResponse.status === 404) throw new CommerceError(404, 'PromotionNotFound', 'Cart discount was not found');
    if (!currentResponse.ok) throw new CommerceError(502, 'PromotionReadFailed', 'Unable to read the cart discount');
    const current = z.object({ version: z.number().int().positive() }).parse(await currentResponse.json());
    const response = await this.commerce(`/cart-discounts/${encodeURIComponent(id)}?version=${current.version}`, { method: 'DELETE' });
    if (response.status === 404) throw new CommerceError(404, 'PromotionNotFound', 'Cart discount was not found');
    if (response.status === 409) throw new CommerceError(409, 'PromotionChanged', 'Cart discount changed; refresh and try again');
    if (!response.ok) throw new CommerceError(502, 'PromotionRemovalFailed', 'Unable to remove the cart discount');
    return { removed: true, id };
  }
}
