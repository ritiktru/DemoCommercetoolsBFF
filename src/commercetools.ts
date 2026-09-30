import { z } from 'zod';
import type { Config } from './config.js';
import { createHash } from 'node:crypto';
import type { GoogleIdentity } from './google.js';
import { cartSchema, type CartInput, type CartResult, type CartService } from './carts/cart.js';
import type { SessionCustomer } from './sessions.js';
import { PERCENT_DISCOUNT_CODE,PERCENT_DISCOUNT,FLAT_DISCOUNT_CODE,FLAT_DISCOUNT_CENTS, FREE_SHIPPING_CODE, storeKeySchema, type AddItemInput, type CheckoutAddressInput,type RemoveDiscountInput, type ApplyDiscountInput, type StorefrontService } from './storefront/storefront.js';

export const customerInput = z.strictObject({
  email: z.email().max(254),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
});
export type CustomerInput = z.infer<typeof customerInput>;
const customerSchema = z.object({
  id: z.string(), version: z.number(), email: z.string(),
  firstName: z.string().optional(), lastName: z.string().optional(),
  authenticationMode: z.literal('ExternalAuth'), isEmailVerified: z.boolean(),
  createdAt: z.string(),
  key: z.string().optional(),
});
const customerResult = z.object({ customer: customerSchema });
export type CustomerResult = z.infer<typeof customerResult>;
export interface CustomerService { createCustomer(input: CustomerInput): Promise<CustomerResult> }
export class CommerceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export class CommercetoolsClient implements CustomerService, CartService, StorefrontService {
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

  async createCart(input: CartInput, customer: SessionCustomer): Promise<CartResult> {
    const scopes = this.config.CT_SCOPES.split(/\s+/);
    if (!scopes.includes(`manage_project:${this.config.CT_PROJECT_KEY}`) && !scopes.includes(`manage_orders:${this.config.CT_PROJECT_KEY}`)) {
      throw new CommerceError(503, 'CartScopeMissing', 'Configure manage_orders for this project in CT_SCOPES and the API Client');
    }
    const response = await this.fetcher(`${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}/carts`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: input.currency, country: input.country, customerId: customer.id, customerEmail: customer.email }),
    });
    await this.checkCartResponse(response);
    const cart = cartSchema.parse(await response.json());
    if (cart.customerId !== customer.id) throw new CommerceError(502, 'CommerceResponseInvalid', 'Commerce returned an unexpected cart owner');
    return { cart };
  }

  async getCart(id: string, customer: SessionCustomer): Promise<CartResult> {
    const response = await this.fetcher(`${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}/carts/${encodeURIComponent(id)}`, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
    await this.checkCartResponse(response);
    const cart = cartSchema.parse(await response.json());
    // Treat other customers' and anonymous carts as absent; never return their contents.
    if (cart.customerId !== customer.id) throw new CommerceError(404, 'CartNotFound', 'Cart not found');
    return { cart };
  }

  private async checkCartResponse(response: Response): Promise<void> {
    if (response.ok) return;
    if (response.status === 401) this.token = undefined;
    if (response.status === 404) throw new CommerceError(404, 'CartNotFound', 'Cart or referenced customer not found');
    if (response.status === 400) throw new CommerceError(400, 'InvalidCart', 'Commerce rejected the cart update. Check product, tax, address, and shipping configuration.');
    if (response.status === 429) throw new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later');
    throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to complete cart request in commerce service');
  }

  private async commerce(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(`${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  }

  async listStores() {
    const response = await this.commerce('/stores?limit=500');
    if (!response.ok) throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to load Stores');
    const result = z.object({
      results: z.array(z.object({
        key: z.string(),
        name: z.record(z.string(), z.string()).optional(),
        productSelections: z.array(z.object({ active: z.boolean() })).default([]),
      })),
    }).parse(await response.json());
    const stores = result.results
      .filter(store => storeKeySchema.safeParse(store.key).success && store.productSelections.some(selection => selection.active))
      .map(store => ({ key: store.key, name: store.name?.['en-CA'] ?? store.name?.['en-US'] ?? Object.values(store.name ?? {})[0] ?? store.key }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return { stores };
  }

  async listStoreProducts(storeKey: string) {
    const [assignments, channelResponse] = await Promise.all([
      this.commerce(`/in-store/key=${encodeURIComponent(storeKey)}/product-selection-assignments?limit=100`),
      this.commerce(`/channels/key=${encodeURIComponent(`${storeKey}-channel`)}`),
    ]);
    if (!assignments.ok || !channelResponse.ok) throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to load Store assortment');
    const channelId = z.object({ id: z.string() }).parse(await channelResponse.json()).id;
    const assigned = z.object({ results: z.array(z.object({ product: z.object({ id: z.string() }) })) }).parse(await assignments.json());
    const products = await Promise.all(assigned.results.map(async ({ product }) => {
      const params = new URLSearchParams({ priceCurrency: 'CAD', priceCountry: 'CA', priceChannel: channelId });
      const response = await this.commerce(`/in-store/key=${encodeURIComponent(storeKey)}/product-projections/${encodeURIComponent(product.id)}?${params}`);
      if (!response.ok) throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to load Store product');
      const raw = z.object({ id: z.string(), key: z.string().optional(), name: z.record(z.string(), z.string()), masterVariant: z.object({ sku: z.string().optional(), price: z.object({ value: z.object({ currencyCode: z.string(), centAmount: z.number(), fractionDigits: z.number().optional() }) }).optional(), attributes: z.array(z.object({ name: z.string(), value: z.unknown() })) }) }).parse(await response.json());
      const attributes = Object.fromEntries(raw.masterVariant.attributes.map(attribute => [attribute.name, attribute.value]));
      return { id: raw.id, key: raw.key, name: raw.name['en-CA'] ?? raw.name['en-US'] ?? Object.values(raw.name)[0], sku: raw.masterVariant.sku, brand: attributes['pace-brand'], price: raw.masterVariant.price?.value };
    }));
    return { storeKey, products };
  }

  async createStoreCart(storeKey: string, customer?: SessionCustomer) {
    const storeResponse = await this.commerce(`/stores/key=${encodeURIComponent(storeKey)}`);
    if (!storeResponse.ok) throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to prepare Store cart');
    if (customer) {
      const customerResponse = await this.commerce(`/customers/${encodeURIComponent(customer.id)}`);
      if (!customerResponse.ok) throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to prepare Store cart');
      const commerceCustomer = z.object({ version: z.number(), stores: z.array(z.object({ id: z.string().optional(), key: z.string().optional() })).default([]) }).parse(await customerResponse.json());
      const store = z.object({ id: z.string() }).parse(await storeResponse.clone().json());
      if (!commerceCustomer.stores.some(reference => reference.id === store.id || reference.key === storeKey)) {
        const linked = await this.commerce(`/customers/${encodeURIComponent(customer.id)}`, { method: 'POST', body: JSON.stringify({ version: commerceCustomer.version, actions: [{ action: 'addStore', store: { typeId: 'store', id: store.id } }] }) });
        if (!linked.ok) {
          let detail = '';
          try { const body = await linked.clone().json() as { message?: string; errors?: Array<{ code?: string; message?: string }> }; detail = body.errors?.map(error => `${error.code ?? 'Error'}: ${error.message ?? ''}`).join('; ') || body.message || ''; } catch { /* retain fallback */ }
          throw new CommerceError(502, 'CustomerStoreAssociationFailed', detail || 'Unable to associate customer with Store');
        }
      }
      const existing = await this.commerce(`/carts?where=${encodeURIComponent(`customerId=\"${customer.id}\" and cartState=\"Active\"`)}&sort=lastModifiedAt%20desc&limit=100`);
      if (existing.ok) {
        const results = z.object({ results: z.array(z.unknown()) }).parse(await existing.json()).results;
        for (const candidate of results) {
          const parsed = cartSchema.safeParse(candidate);
          const raw = candidate as { store?: { key?: string }; storeRef?: { key?: string } };
          if (parsed.success && (raw.store?.key === storeKey || raw.storeRef?.key === storeKey)) return { cart: parsed.data };
        }
      }
    }
    const body = customer
      ? { currency: 'CAD', country: 'CA', customerId: customer.id, customerEmail: customer.email, store: { typeId: 'store', key: storeKey } }
      : { currency: 'CAD', country: 'CA', store: { typeId: 'store', key: storeKey } };
    const response = await this.commerce('/carts', { method: 'POST', body: JSON.stringify(body) });
    await this.checkCartResponse(response); return { cart: cartSchema.parse(await response.json()) };
  }

  async addStoreCartItem(storeKey: string, input: AddItemInput, customer?: SessionCustomer) {
    const existing = await this.commerce(`/carts/${encodeURIComponent(input.cartId)}`);
    await this.checkCartResponse(existing); const cart = cartSchema.parse(await existing.json());
    if (customer ? cart.customerId !== customer.id : cart.customerId) throw new CommerceError(404, 'CartNotFound', 'Cart not found');
    if (cart.version !== input.version) throw new CommerceError(409, 'ConcurrentModification', 'Cart changed; refresh and try again');
    const response = await this.commerce(`/carts/${encodeURIComponent(input.cartId)}`, { method: 'POST', body: JSON.stringify({ version: input.version, actions: [{ action: 'addLineItem', sku: input.sku, quantity: input.quantity, distributionChannel: { typeId: 'channel', key: `${storeKey}-channel` }, supplyChannel: { typeId: 'channel', key: `${storeKey}-channel` } }] }) });
    await this.checkCartResponse(response); return { cart: cartSchema.parse(await response.json()) };
  }

  private async getCheckoutCart(storeKey: string, cartId: string, customer?: SessionCustomer) {
    const response = await this.commerce(`/carts/${encodeURIComponent(cartId)}`);
    if (!response.ok) throw new CommerceError(404, 'CartNotFound', 'Cart not found');
    const raw = await response.json();
    const cart = cartSchema.parse(raw);
    const store = z.object({ store: z.object({ key: z.string().optional(), id: z.string().optional() }).optional() }).parse(raw).store;
    if (customer ? cart.customerId !== customer.id : cart.customerId) throw new CommerceError(404, 'CartNotFound', 'Cart not found');
    if (store?.key !== storeKey) throw new CommerceError(404, 'CartNotFound', 'Cart not found for the selected Store');
    if (cart.cartState !== 'Active') throw new CommerceError(409, 'CartNotActive', 'This cart is no longer active');
    return { cart, raw };
  }

  async setCheckoutAddress(storeKey: string, input: CheckoutAddressInput, customer?: SessionCustomer) {
    const { cart } = await this.getCheckoutCart(storeKey, input.cartId, customer);
    if (!cart.lineItems.length) throw new CommerceError(400, 'EmptyCart', 'Add at least one product before checkout');
    // commercetools tax rates match shippingAddress.state exactly; this POC's
    // Canadian rate is configured as "Ontario", not the postal abbreviation "ON".
    const state = /^on(tario)?$/i.test(input.address.state) ? 'Ontario' : input.address.state;
    const address = { ...input.address, state, country: 'CA', email: input.email };
    const actions: object[] = [
      { action: 'setShippingAddress', address },
      { action: 'setBillingAddress', address },
    ];
    if (!customer) actions.push({ action: 'setCustomerEmail', email: input.email });
    const response = await this.commerce(`/carts/${encodeURIComponent(input.cartId)}`, {
      method: 'POST', body: JSON.stringify({ version: cart.version, actions }),
    });
    await this.checkCartResponse(response);
    return { cart: cartSchema.parse(await response.json()) };
  }

async listCheckoutShippingMethods(storeKey: string, cartId: string, customer?: SessionCustomer) {
  const { raw } = await this.getCheckoutCart(storeKey, cartId, customer);
  if (!z.object({ shippingAddress: z.object({ country: z.literal('CA') }).optional() }).parse(raw).shippingAddress) {
    throw new CommerceError(400, 'ShippingAddressMissing', 'Enter a shipping address first');
  }
  const response = await this.commerce(`/shipping-methods/matching-cart?cartId=${encodeURIComponent(cartId)}`);
  if (!response.ok) throw new CommerceError(502, 'ShippingMethodsFailed', 'Unable to load shipping methods');
  const result = z.object({
    results: z.array(z.object({
      id: z.string(),
      name: z.string(),
      isDefault: z.boolean().optional(),
      zoneRates: z.array(z.object({
        shippingRates: z.array(z.object({
          price: z.object({
            currencyCode: z.string(),
            centAmount: z.number(),
            fractionDigits: z.number().optional(),
          }),
        })),
      })).optional(),
    })),
  }).parse(await response.json());
  return {
    shippingMethods: result.results.map(method => ({
      id: method.id,
      name: method.name,
      isDefault: method.isDefault,
      price: method.zoneRates?.[0]?.shippingRates?.[0]?.price,
    })),
  };
}

  async setCheckoutShippingMethod(storeKey: string, cartId: string, shippingMethodId: string, customer?: SessionCustomer) {
    const { cart } = await this.getCheckoutCart(storeKey, cartId, customer);
    const { shippingMethods } = await this.listCheckoutShippingMethods(storeKey, cartId, customer);
    if (!shippingMethods.some(method => method.id === shippingMethodId)) {
      throw new CommerceError(400, 'ShippingMethodNotAvailable', 'The selected shipping method is not available for this address');
    }
    const response = await this.commerce(`/carts/${encodeURIComponent(cartId)}`, {
      method: 'POST', body: JSON.stringify({ version: cart.version, actions: [{ action: 'setShippingMethod', shippingMethod: { typeId: 'shipping-method', id: shippingMethodId } }] }),
    });
    await this.checkCartResponse(response);
    return { cart: cartSchema.parse(await response.json()) };
  }

async applyStoreCartDiscount(storeKey: string, input: ApplyDiscountInput, customer?: SessionCustomer) {
  const { cart, raw } = await this.getCheckoutCart(storeKey, input.cartId, customer);
  if (cart.version !== input.version) {
    throw new CommerceError(409, 'ConcurrentModification', 'Cart changed; refresh and try again');
  }
  if (!cart.lineItems.length) throw new CommerceError(400, 'EmptyCart', 'Add a product before applying a code');

  const code = input.code.trim().toUpperCase();
  const existing = this.readDirectDiscounts(raw);
  let discounts;

  if (code === FREE_SHIPPING_CODE) {
    discounts = [...existing.filter(item => item.target?.type !== 'shipping'), this.freeShippingDiscount()];
  } else {
    const product = this.directDiscountFor(code, cart.totalPrice.currencyCode, cart.totalPrice.centAmount);
    discounts = [
      ...existing.filter(item => item.target?.type === 'shipping'),
      product.action,
    ];
    const response = await this.commerce(`/carts/${encodeURIComponent(input.cartId)}`, {
      method: 'POST',
      body: JSON.stringify({
        version: cart.version,
        actions: [{ action: 'setDirectDiscounts', discounts }],
      }),
    });
    await this.checkCartResponse(response);
    return {
      cart: cartSchema.parse(await response.json()),
      discountCode: product.code,
      type: product.type,
      percent: product.percent,
      amount: product.amount,
    };
  }

  const response = await this.commerce(`/carts/${encodeURIComponent(input.cartId)}`, {
    method: 'POST',
    body: JSON.stringify({
      version: cart.version,
      actions: [{ action: 'setDirectDiscounts', discounts }],
    }),
  });
  await this.checkCartResponse(response);
  return {
    cart: cartSchema.parse(await response.json()),
    discountCode: FREE_SHIPPING_CODE,
    type: 'shipping' as const,
  };
}

async removeStoreCartDiscount(storeKey: string, input: RemoveDiscountInput, customer?: SessionCustomer) {
  const { cart, raw } = await this.getCheckoutCart(storeKey, input.cartId, customer);
  if (cart.version !== input.version) {
    throw new CommerceError(409, 'ConcurrentModification', 'Cart changed; refresh and try again');
  }
  const existing = this.readDirectDiscounts(raw);
  const discounts =
    input.kind === 'shipping'
      ? existing.filter(item => item.target?.type !== 'shipping')
      : input.kind === 'product'
        ? existing.filter(item => item.target?.type === 'shipping')
        : [];

  const response = await this.commerce(`/carts/${encodeURIComponent(input.cartId)}`, {
    method: 'POST',
    body: JSON.stringify({
      version: cart.version,
      actions: [{ action: 'setDirectDiscounts', discounts }],
    }),
  });
  await this.checkCartResponse(response);
  return { cart: cartSchema.parse(await response.json()) };
}

private readDirectDiscounts(raw: unknown) {
  const parsed = z.object({
    directDiscounts: z.array(z.object({
      value: z.unknown(),
      target: z.object({ type: z.string(), predicate: z.string().optional() }).passthrough(),
    }).passthrough()).optional(),
  }).safeParse(raw);
  return parsed.success ? (parsed.data.directDiscounts ?? []) : [];
}

private freeShippingDiscount() {
  return {
    value: { type: 'relative' as const, permyriad: 10000 },
    target: { type: 'shipping' as const },
  };
}

private directDiscountFor(code: string, currencyCode: string, cartCents: number) {
  if (code === PERCENT_DISCOUNT_CODE) {
    return {
      code: PERCENT_DISCOUNT_CODE,
      type: 'percent' as const,
      percent: PERCENT_DISCOUNT,
      amount: undefined,
      action: {
        value: { type: 'relative' as const, permyriad: PERCENT_DISCOUNT * 100 },
        target: { type: 'lineItems' as const, predicate: '1 = 1' },
      },
    };
  }
  if (code === FLAT_DISCOUNT_CODE) {
    if (cartCents <= FLAT_DISCOUNT_CENTS) {
      throw new CommerceError(
        400,
        'DiscountExceedsCart',
        `Cart total must be more than $${(FLAT_DISCOUNT_CENTS / 100).toFixed(2)} to use ${FLAT_DISCOUNT_CODE}.`,
      );
    }
    return {
      code: FLAT_DISCOUNT_CODE,
      type: 'flat' as const,
      percent: undefined,
      amount: { currencyCode, centAmount: FLAT_DISCOUNT_CENTS },
      action: {
        value: {
          type: 'absolute' as const,
          money: [{ currencyCode, centAmount: FLAT_DISCOUNT_CENTS }],
        },
        target: { type: 'lineItems' as const, predicate: '1 = 1' },
      },
    };
  }
  throw new CommerceError(
    400,
    'InvalidDiscountCode',
    `Invalid code. Use ${PERCENT_DISCOUNT_CODE} (10% off) or ${FLAT_DISCOUNT_CODE} ($25 off).`,
  );
}

  async createCheckoutSession(storeKey: string, cartId: string, customer?: SessionCustomer) {
    if (!this.config.CT_CHECKOUT_SESSION_URL || !this.config.CT_CHECKOUT_APPLICATION_KEY) {
      throw new CommerceError(503, 'CheckoutNotConfigured', 'Set CT_CHECKOUT_SESSION_URL and CT_CHECKOUT_APPLICATION_KEY');
    }
    const { cart, raw } = await this.getCheckoutCart(storeKey, cartId, customer);
    if (!cart.lineItems.length) throw new CommerceError(400, 'EmptyCart', 'Add at least one product before checkout');
    const prepared = z.object({ shippingAddress: z.unknown().optional(), billingAddress: z.unknown().optional(), shippingInfo: z.unknown().optional() }).parse(raw);
    if (!prepared.shippingAddress || !prepared.billingAddress || !prepared.shippingInfo) {
      throw new CommerceError(400, 'CheckoutNotReady', 'Enter an address and select a shipping method before payment');
    }
    const sessionResponse = await this.fetcher(`${this.config.CT_CHECKOUT_SESSION_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}/sessions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart: { cartRef: { id: cartId } }, metadata: { applicationKey: this.config.CT_CHECKOUT_APPLICATION_KEY } }),
    });
    if (!sessionResponse.ok) throw new CommerceError(502, 'CheckoutSessionFailed', 'Unable to create Checkout Session');
    const result = z.object({ id: z.string().min(1) }).parse(await sessionResponse.json());
    return { sessionId: result.id };
  }

  async createCustomer(input: CustomerInput): Promise<CustomerResult> {
    // Explicit allowlist: passwords, verification flags, and identity IDs cannot be supplied by callers.
    const draft = { email: input.email, firstName: input.firstName, lastName: input.lastName, authenticationMode: 'ExternalAuth' };
    return this.createDraft(draft);
  }

  private async createDraft(draft: object): Promise<CustomerResult> {
    const response = await this.fetcher(`${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}/customers`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      if (response.status === 401) this.token = undefined;
      if (response.status === 409) throw new CommerceError(409, 'CustomerAlreadyExists', 'A customer with this email already exists');
      if (response.status === 429) throw new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later');
      throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to create customer in commerce service');
    }
    // Strip unknown upstream fields, including any sensitive fields.
    return customerResult.parse(await response.json());
  }

  private async findCustomer(field: 'key' | 'email', value: string): Promise<z.infer<typeof customerSchema> | undefined> {
    const params = new URLSearchParams({ where: `${field}=${JSON.stringify(value)}`, limit: '2' });
    const response = await this.fetcher(`${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}/customers?${params}`, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!response.ok) throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to retrieve commerce customer');
    // Parse after checking authenticationMode so password customers cannot be linked.
    const result = z.object({ results: z.array(z.object({ authenticationMode: z.string() }).passthrough()) }).parse(await response.json());
    if (result.results.length > 1) throw new CommerceError(409, 'AccountLinkRequired', 'Customer identity needs manual review');
    const customer = result.results[0];
    if (!customer) return undefined;
    if (customer.authenticationMode !== 'ExternalAuth') throw new CommerceError(409, 'AccountLinkRequired', 'Existing account requires a separate identity linking flow');
    return customerSchema.parse(customer);
  }

  async resolveGoogleCustomer(identity: GoogleIdentity): Promise<CustomerResult> {
    // commercetools keys are unique: persistent mapping uses Google's stable subject, never email.
    const key = `google-${createHash('sha256').update(identity.subject).digest('hex')}`;
    const linked = await this.findCustomer('key', key);
    if (linked) return { customer: linked };
    // Google is authoritative for Gmail and verified Workspace email only.
    // Third-party Google-account emails need a separate email verification flow.
    if (!identity.authoritativeEmail) throw new CommerceError(403, 'EmailVerificationRequired', 'For this POC, use a Gmail or Google Workspace account');
    const existing = await this.findCustomer('email', identity.email.toLowerCase());
    try {
      if (!existing) {
        return await this.createDraft({
          email: identity.email.toLowerCase(), firstName: identity.firstName, lastName: identity.lastName,
          authenticationMode: 'ExternalAuth', key, isEmailVerified: true,
        });
      }
      if (existing.key && existing.key !== key) throw new CommerceError(409, 'AccountLinkRequired', 'Existing account is already linked or has a reserved customer key');
      const response = await this.fetcher(`${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}/customers/${encodeURIComponent(existing.id)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: existing.version, actions: [{ action: 'setKey', key }] }),
      });
      if (response.status === 409) throw new CommerceError(409, 'CustomerAlreadyExists', 'Customer changed during login');
      if (!response.ok) throw new CommerceError(502, 'CommerceRequestFailed', 'Unable to link commerce customer');
      return { customer: customerSchema.parse(await response.json()) };
    } catch (error) {
      // Concurrent first logins can race; resolve only the same stable Google identity.
      if (error instanceof CommerceError && error.code === 'CustomerAlreadyExists') {
        const resolved = await this.findCustomer('key', key);
        if (resolved) return { customer: resolved };
        throw new CommerceError(409, 'LoginConflict', 'Customer changed during login; reload and try again');
      }
      throw error;
    }
  }
}
