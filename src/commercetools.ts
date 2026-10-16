import { z } from 'zod';
import { ClientBuilder, type TokenStore } from '@commercetools/sdk-client-v2';
import { createApiBuilderFromCtpClient, type CartUpdateAction, type ClientResponse, type CustomerDraft, type PaymentUpdateAction } from '@commercetools/platform-sdk';
import type { Config } from './config.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { TransactionStore, pspOf, validAdyenHmac, type AdyenNotificationItem, type PaymentOperation, type PaymentStatus, type Transaction } from './payments.js';
import type { GoogleIdentity } from './google.js';
import { cartSchema, type CartInput, type CartResult, type CartService } from './carts/cart.js';
import type { SessionCustomer } from './sessions.js';
import type { AddItemInput, CheckoutAddressInput, DiscountCodeInput, StorefrontService, UpdateItemInput } from './storefront/storefront.js';

export const customerInput = z.strictObject({
  email: z.email().max(254),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
});
export type CustomerInput = z.infer<typeof customerInput>;
export const registerInput = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
});
export type RegisterInput = z.infer<typeof registerInput>;
const customerSchema = z.object({
  id: z.string(), version: z.number(), email: z.string(),
  firstName: z.string().optional(), lastName: z.string().optional(),
  authenticationMode: z.enum(['ExternalAuth', 'Password']), isEmailVerified: z.boolean(),
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

type SdkError = { statusCode?: number; body?: { errors?: Array<{ code?: string; message?: string }> } };
const statusOf = (error: unknown) => (error as SdkError).statusCode ?? 0;
const codesOf = (error: unknown) => (error as SdkError).body?.errors?.map(e => e.code) ?? [];
const failWith = (message: string) => () => new CommerceError(502, 'CommerceRequestFailed', message);
function cartFail(status: number): CommerceError {
  if (status === 404) return new CommerceError(404, 'CartNotFound', 'Cart or referenced customer not found');
  if (status === 400) return new CommerceError(400, 'InvalidCart', 'Commerce rejected the cart update. Check product, tax, address, and shipping configuration.');
  if (status === 409) return new CommerceError(409, 'ConcurrentModification', 'Cart changed; refresh and try again');
  if (status === 429) return new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later');
  return new CommerceError(502, 'CommerceRequestFailed', 'Unable to complete cart request in commerce service');
}
// Carts always come back with discount code text so the storefront can show and remove codes.
const cartArgs = { expand: ['discountCodes[*].discountCode'] };
type StoreContext = { country: string; currency: string; channel?: { id: string; key: string } };
const CURRENCY_BY_COUNTRY: Record<string, string> = { CA: 'CAD', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', NL: 'EUR', AU: 'AUD' };
const origin = (url: string) => url.replace(/\/$/, '');
const ADYEN_CHECKOUT_URL = 'https://checkout-test.adyen.com/v71';
const ORDER_PAYMENT_TYPE_KEY = 'internal-payment-reference-type';
// How our payment statuses show on the commercetools Payment and its order.
const STATUS_TEXT: Record<PaymentStatus, string> = {
  INITIATED: 'Payment started', PENDING: 'Waiting for confirmation', AUTHORISED: 'Money held', REFUSED: 'Refused', EXPIRED: 'Expired',
  CAPTURED: 'Money taken', CANCELLED: 'Hold released', PARTIALLY_REFUNDED: 'Partly refunded', REFUNDED: 'Refunded',
};
const ORDER_PAYMENT_STATE: Partial<Record<PaymentStatus, 'Pending' | 'Paid' | 'Failed'>> = {
  AUTHORISED: 'Pending', CAPTURED: 'Paid', PARTIALLY_REFUNDED: 'Paid', REFUNDED: 'Paid', CANCELLED: 'Failed',
};
const CT_TRANSACTION = { CAPTURE: 'Charge', REFUND: 'Refund', CANCEL: 'CancelAuthorization' } as const;

export class CommercetoolsClient implements CustomerService, CartService, StorefrontService {
  private tokenStore: TokenStore = { token: '', expirationTime: -1 };
  private readonly api;
  private readonly transactions: TransactionStore;
  private readonly ordering = new Map<string, Promise<NonNullable<Transaction['order']>>>();
  // One capture/refund/cancel at a time per payment, so a double click cannot send two modifications.
  private readonly modifying = new Set<string>();
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {
    const client = new ClientBuilder()
      .withClientCredentialsFlow({
        host: origin(config.CT_AUTH_URL), projectKey: config.CT_PROJECT_KEY,
        credentials: { clientId: config.CT_CLIENT_ID, clientSecret: config.CT_CLIENT_SECRET },
        scopes: config.CT_SCOPES.split(/\s+/), fetch: fetcher,
        tokenCache: { get: () => this.tokenStore, set: token => { this.tokenStore = token; } },
      })
      .withHttpMiddleware({ host: origin(config.CT_API_URL), fetch: fetcher, timeout: 15000, getAbortController: () => new AbortController(), enableRetry: false })
      .build();
    this.transactions = new TransactionStore(config.PAYMENT_STORE_PATH);
    this.api = createApiBuilderFromCtpClient(client).withProjectKey({ projectKey: config.CT_PROJECT_KEY });
  }

  private async ct<T>(request: { execute(): Promise<ClientResponse<T>> }, fail: (status: number, error: unknown) => CommerceError = cartFail): Promise<T> {
    try { return (await request.execute()).body; }
    catch (error) {
      if (error instanceof CommerceError) throw error;
      const status = statusOf(error);
      if (status === 401) this.tokenStore = { token: '', expirationTime: -1 };
      throw fail(status, error);
    }
  }

  private store(storeKey: string) { return this.api.inStoreKeyWithStoreKeyValue({ storeKey }); }
  private postCart(cartId: string, version: number, actions: CartUpdateAction[], fail = cartFail) {
    return this.ct(this.api.carts().withId({ ID: cartId }).post({ queryArgs: cartArgs, body: { version, actions } }), fail);
  }

  async createCart(input: CartInput, customer: SessionCustomer): Promise<CartResult> {
    const scopes = this.config.CT_SCOPES.split(/\s+/);
    if (!scopes.includes(`manage_project:${this.config.CT_PROJECT_KEY}`) && !scopes.includes(`manage_orders:${this.config.CT_PROJECT_KEY}`)) {
      throw new CommerceError(503, 'CartScopeMissing', 'Configure manage_orders for this project in CT_SCOPES and the API Client');
    }
    const cart = cartSchema.parse(await this.ct(this.api.carts().post({ queryArgs: cartArgs, body: { currency: input.currency, country: input.country, customerId: customer.id, customerEmail: customer.email } })));
    if (cart.customerId !== customer.id) throw new CommerceError(502, 'CommerceResponseInvalid', 'Commerce returned an unexpected cart owner');
    return { cart };
  }

  async getCart(id: string, customer: SessionCustomer): Promise<CartResult> {
    const cart = cartSchema.parse(await this.ct(this.api.carts().withId({ ID: id }).get({ queryArgs: cartArgs })));
    // Treat other customers' and anonymous carts as absent; never return their contents.
    if (cart.customerId !== customer.id) throw new CommerceError(404, 'CartNotFound', 'Cart not found');
    return { cart };
  }

  private contexts = new Map<string, { at: number; value: Promise<StoreContext> }>();
  // Country, currency and Channel are read from commercetools per Store (cached 1 minute), not hard-coded.
  private storeContext(storeKey: string): Promise<StoreContext> {
    const hit = this.contexts.get(storeKey);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = (async () => {
      const [store, project] = await Promise.all([
        this.ct(this.api.stores().withKey({ key: storeKey }).get(), status => status === 404 ? new CommerceError(404, 'StoreNotFound', 'Store not found') : failWith('Unable to load Store')()),
        this.ct(this.api.get(), failWith('Unable to load project')),
      ]);
      const country = store.countries?.[0]?.code ?? project.countries[0] ?? 'CA';
      const preferred = CURRENCY_BY_COUNTRY[country];
      const currency = preferred && project.currencies.includes(preferred) ? preferred : project.currencies[0] ?? 'CAD';
      const channel = await this.ct(this.api.channels().withKey({ key: `${storeKey}-channel` }).get(), () => new CommerceError(404, 'ChannelNotFound', '')).catch(() => undefined);
      return { country, currency, channel: channel && { id: channel.id, key: channel.key } };
    })();
    this.contexts.set(storeKey, { at: Date.now(), value });
    value.catch(() => this.contexts.delete(storeKey));
    return value;
  }

  // Reads the configured cart discount via the SDK and exposes only what a shopper needs:
  // the percentage and the cart-total threshold parsed from its cartPredicate.
  async getPromotion() {
    const key = this.config.CT_PROMO_DISCOUNT_KEY;
    if (!key) throw new CommerceError(404, 'PromotionNotFound', 'No promotion configured');
    const discount = await this.ct(this.api.cartDiscounts().withKey({ key }).get(), status =>
      status === 404 ? new CommerceError(404, 'PromotionNotFound', 'No promotion configured') : failWith('Unable to load promotion')());
    const now = Date.now();
    const live = discount.isActive && !discount.requiresDiscountCode && discount.target?.type === 'totalPrice'
      && discount.value.type === 'relative' && (!discount.validFrom || Date.parse(discount.validFrom) <= now) && (!discount.validUntil || Date.parse(discount.validUntil) > now);
    if (!live || discount.value.type !== 'relative') throw new CommerceError(404, 'PromotionNotFound', 'No promotion available');
    // ponytail: understands `totalPrice >= "N CUR"` clauses joined by `or`; any other predicate yields no thresholds.
    const clauses = discount.cartPredicate.split(/\s+or\s+/).map(clause => /^\s*\(?\s*totalPrice\s*>=\s*"(\d+(?:\.\d+)?)\s+([A-Z]{3})"\s*\)?\s*$/.exec(clause));
    const thresholds = clauses.every(Boolean) ? clauses.map(m => ({ currencyCode: m![2]!, centAmount: Math.round(Number(m![1]) * 100) })) : [];
    const name = discount.name['en-CA'] ?? discount.name['en-US'] ?? Object.values(discount.name)[0] ?? key;
    return { promotion: { key, name, percent: discount.value.permyriad / 100, thresholds } };
  }

  async listStores() {
    const { results } = await this.ct(this.api.stores().get({ queryArgs: { limit: 50, sort: 'key asc' } }), failWith('Unable to load Stores'));
    return { stores: results.map(store => ({ key: store.key, name: store.name?.['en-CA'] ?? store.name?.['en-US'] ?? Object.values(store.name ?? {})[0] ?? store.key })) };
  }

  async listStoreProducts(storeKey: string) {
    const context = await this.storeContext(storeKey);
    const assigned = await this.ct(this.store(storeKey).productSelectionAssignments().get({ queryArgs: { limit: 100 } }), failWith('Unable to load Store assortment'));
    // A Store with Product Selections sells only those products; with none, the whole catalog is sellable.
    const where = assigned.results.length ? `id in (${assigned.results.map(({ product }) => JSON.stringify(product.id)).join(',')})` : undefined;
    const projections = await this.ct(this.api.productProjections().get({
      queryArgs: { where, limit: 100, priceCurrency: context.currency, priceCountry: context.country, ...(context.channel && { priceChannel: context.channel.id }) },
    }), failWith('Unable to load Store product'));
    const products = projections.results.map(raw => {
      const attributes = Object.fromEntries((raw.masterVariant.attributes ?? []).map(attribute => [attribute.name, attribute.value]));
      const price = raw.masterVariant.price;
      return {
        id: raw.id, key: raw.key, name: raw.name['en-CA'] ?? raw.name['en-US'] ?? Object.values(raw.name)[0],
        sku: raw.masterVariant.sku, brand: attributes['pace-brand'] ?? attributes['brand'], image: raw.masterVariant.images?.[0]?.url,
        price: price?.value, discountedPrice: price?.discounted?.value,
      };
    });
    return { storeKey, country: context.country, products };
  }

  // One product with every variant, priced for the Store's country, currency and Channel.
  // The in-store endpoint enforces the Store's Product Selections, so unavailable products are 404.
  async getStoreProduct(storeKey: string, productKey: string) {
    const context = await this.storeContext(storeKey);
    const raw = await this.ct(this.store(storeKey).productProjections().withKey({ key: productKey }).get({
      queryArgs: { priceCurrency: context.currency, priceCountry: context.country, ...(context.channel && { priceChannel: context.channel.id }) },
    }), status => status === 404 ? new CommerceError(404, 'ProductNotFound', 'Product not found') : failWith('Unable to load product')());
    const variants = [raw.masterVariant, ...(raw.variants ?? [])].map(variant => ({
      id: variant.id, sku: variant.sku, images: (variant.images ?? []).map(image => ({ url: image.url, label: image.label })),
      price: variant.price?.value, discountedPrice: variant.price?.discounted?.value,
      attributes: (variant.attributes ?? []).map(attribute => ({ name: attribute.name, value: attribute.value })),
    }));
    const text = (record?: Record<string, string>) => record?.['en-GB'] ?? record?.['en-US'] ?? record?.['en-CA'] ?? (record && Object.values(record)[0]);
    return { product: { id: raw.id, key: raw.key, name: text(raw.name), description: text(raw.description), variants } };
  }

  async createStoreCart(storeKey: string, customer?: SessionCustomer) {
    const unable = failWith('Unable to prepare Store cart');
    const context = await this.storeContext(storeKey);
    if (customer) {
      const store = await this.ct(this.api.stores().withKey({ key: storeKey }).get(), unable);
      const commerceCustomer = await this.ct(this.api.customers().withId({ ID: customer.id }).get(), unable);
      if (!(commerceCustomer.stores ?? []).some(reference => reference.key === storeKey)) {
        await this.ct(this.api.customers().withId({ ID: customer.id }).post({ body: { version: commerceCustomer.version, actions: [{ action: 'addStore', store: { typeId: 'store', id: store.id } }] } }), (_status, error) => {
          const detail = (error as SdkError).body?.errors?.map(e => `${e.code ?? 'Error'}: ${e.message ?? ''}`).join('; ');
          return new CommerceError(502, 'CustomerStoreAssociationFailed', detail || 'Unable to associate customer with Store');
        });
      }
      const existing = await this.ct(this.api.carts().get({ queryArgs: { ...cartArgs, where: `customerId="${customer.id}" and cartState="Active"`, sort: 'lastModifiedAt desc', limit: 100 } }), () => new CommerceError(502, 'CommerceRequestFailed', 'Unable to look up existing cart')).catch(() => undefined);
      for (const candidate of existing?.results ?? []) {
        const parsed = cartSchema.safeParse(candidate);
        if (parsed.success && candidate.store?.key === storeKey) return { cart: parsed.data };
      }
    }
    const draft = { currency: context.currency, country: context.country, store: { typeId: 'store' as const, key: storeKey }, ...(customer && { customerId: customer.id, customerEmail: customer.email }) };
    return { cart: cartSchema.parse(await this.ct(this.api.carts().post({ queryArgs: cartArgs, body: draft }))) };
  }

  private async getCheckoutCart(storeKey: string, cartId: string, customer?: SessionCustomer) {
    const raw = await this.ct(this.api.carts().withId({ ID: cartId }).get({ queryArgs: cartArgs }), () => new CommerceError(404, 'CartNotFound', 'Cart not found'));
    const cart = cartSchema.parse(raw);
    if (customer ? cart.customerId !== customer.id : cart.customerId) throw new CommerceError(404, 'CartNotFound', 'Cart not found');
    if (raw.store?.key !== storeKey) throw new CommerceError(404, 'CartNotFound', 'Cart not found for the selected Store');
    if (cart.cartState !== 'Active') throw new CommerceError(409, 'CartNotActive', 'This cart is no longer active');
    return { cart, raw };
  }

  async getStoreCart(storeKey: string, cartId: string, customer?: SessionCustomer) {
    return { cart: (await this.getCheckoutCart(storeKey, cartId, customer)).cart };
  }

  // Ownership, Store and version checks shared by every shopper-driven cart change.
  private async mutateCart(storeKey: string, cartId: string, version: number, actions: CartUpdateAction[], customer?: SessionCustomer, fail = cartFail) {
    const { cart } = await this.getCheckoutCart(storeKey, cartId, customer);
    if (cart.version !== version) throw new CommerceError(409, 'ConcurrentModification', 'Cart changed; refresh and try again');
    return { cart: cartSchema.parse(await this.postCart(cartId, version, actions, fail)) };
  }

  async addStoreCartItem(storeKey: string, input: AddItemInput, customer?: SessionCustomer) {
    const { channel } = await this.storeContext(storeKey);
    const ref = channel && { typeId: 'channel' as const, key: channel.key };
    return this.mutateCart(storeKey, input.cartId, input.version, [{ action: 'addLineItem', sku: input.sku, quantity: input.quantity, ...(ref && { distributionChannel: ref, supplyChannel: ref }) }], customer);
  }

  // quantity 0 removes the line item.
  updateStoreCartItem(storeKey: string, input: UpdateItemInput, customer?: SessionCustomer) {
    return this.mutateCart(storeKey, input.cartId, input.version, [{ action: 'changeLineItemQuantity', lineItemId: input.lineItemId, quantity: input.quantity }], customer);
  }

  addDiscountCode(storeKey: string, input: DiscountCodeInput, customer?: SessionCustomer) {
    return this.mutateCart(storeKey, input.cartId, input.version, [{ action: 'addDiscountCode', code: input.code }], customer,
      status => status === 400 ? new CommerceError(400, 'InvalidDiscountCode', 'This discount code is not valid') : cartFail(status));
  }

  removeDiscountCode(storeKey: string, input: { cartId: string; version: number; discountCodeId: string }, customer?: SessionCustomer) {
    return this.mutateCart(storeKey, input.cartId, input.version, [{ action: 'removeDiscountCode', discountCode: { typeId: 'discount-code', id: input.discountCodeId } }], customer);
  }

  async setCheckoutAddress(storeKey: string, input: CheckoutAddressInput, customer?: SessionCustomer) {
    const { cart } = await this.getCheckoutCart(storeKey, input.cartId, customer);
    if (!cart.lineItems.length) throw new CommerceError(400, 'EmptyCart', 'Add at least one product before checkout');
    // The address country is the cart's country, which was set from the Store.
    const country = cart.country ?? 'CA';
    // commercetools tax rates match shippingAddress.state exactly; the Sobeys POC's
    // Canadian rate is configured as "Ontario", not the postal abbreviation "ON".
    const fixState = (value: string) => country === 'CA' && /^on(tario)?$/i.test(value) ? 'Ontario' : value;
    const withCountry = (a: CheckoutAddressInput['address']) => ({ ...a, state: fixState(a.state), country, email: input.email });
    const actions: CartUpdateAction[] = [
      { action: 'setShippingAddress', address: withCountry(input.address) },
      { action: 'setBillingAddress', address: withCountry(input.billingAddress ?? input.address) },
    ];
    if (!customer) actions.push({ action: 'setCustomerEmail', email: input.email });
    return { cart: cartSchema.parse(await this.postCart(input.cartId, cart.version, actions)) };
  }

  async listCheckoutShippingMethods(storeKey: string, cartId: string, customer?: SessionCustomer) {
    const { raw } = await this.getCheckoutCart(storeKey, cartId, customer);
    if (!raw.shippingAddress) throw new CommerceError(400, 'ShippingAddressMissing', 'Enter a shipping address first');
    const result = await this.ct(this.api.shippingMethods().matchingCart().get({ queryArgs: { cartId } }), failWith('Unable to load shipping methods'));
    return { shippingMethods: result.results.map(({ id, name, isDefault }) => ({ id, name, isDefault })) };
  }

  async setCheckoutShippingMethod(storeKey: string, cartId: string, shippingMethodId: string, customer?: SessionCustomer) {
    const { cart } = await this.getCheckoutCart(storeKey, cartId, customer);
    const { shippingMethods } = await this.listCheckoutShippingMethods(storeKey, cartId, customer);
    if (!shippingMethods.some(method => method.id === shippingMethodId)) {
      throw new CommerceError(400, 'ShippingMethodNotAvailable', 'The selected shipping method is not available for this address');
    }
    return { cart: cartSchema.parse(await this.postCart(cartId, cart.version, [{ action: 'setShippingMethod', shippingMethod: { typeId: 'shipping-method', id: shippingMethodId } }])) };
  }

  // Step 1-3: validate the cart, open an Adyen Hosted Checkout session and remember cartId -> payment_ref_id -> session.
  // Adyen Drop-in (sessions flow): returns sessionData for the browser SDK. Card entry and 3-D Secure stay inside Adyen's iframes.
  async initiateCheckout(storeKey: string, cartId: string, customer?: SessionCustomer) {
    const { ADYEN_API_KEY, ADYEN_MERCHANT_ACCOUNT, APP_ORIGIN } = this.config;
    if (!ADYEN_API_KEY || !ADYEN_MERCHANT_ACCOUNT || !APP_ORIGIN) throw new CommerceError(503, 'PaymentNotConfigured', 'Set ADYEN_API_KEY, ADYEN_MERCHANT_ACCOUNT and APP_ORIGIN');
    const { cart, raw } = await this.getCheckoutCart(storeKey, cartId, customer);
    if (!cart.lineItems.length) throw new CommerceError(400, 'EmptyCart', 'Add at least one product before checkout');
    if (!raw.shippingAddress || !raw.shippingInfo) throw new CommerceError(400, 'CheckoutNotReady', 'Enter an address and select a delivery method before payment');
    const total = cart.taxedPrice?.totalGross ?? cart.totalPrice;
    const paymentRefId = `PAY-${randomUUID()}`;
    const response = await this.fetcher(`${ADYEN_CHECKOUT_URL}/sessions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'X-API-Key': ADYEN_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': paymentRefId },
      body: JSON.stringify({
        mode: 'embedded', channel: 'Web', merchantAccount: ADYEN_MERCHANT_ACCOUNT, reference: paymentRefId,
        // Adyen minor units match commercetools centAmount for 2-decimal currencies (CAD, USD, EUR, GBP).
        amount: { value: total.centAmount, currency: total.currencyCode },
        countryCode: cart.country, shopperEmail: raw.customerEmail ?? raw.shippingAddress.email,
        returnUrl: `${APP_ORIGIN}/checkout?paymentRef=${paymentRefId}`,
        // Hold only: OrderIQ (or the admin page) captures later.
        additionalData: { manualCapture: 'true' },
        // Saved cards live in Adyen, keyed by the commercetools customer id; guests get no saved cards.
        ...(customer && { shopperReference: customer.id, storePaymentMethodMode: 'askForConsent', recurringProcessingModel: 'CardOnFile' }),
      }),
    }).catch((error: Error) => { console.error('[adyen] /sessions network error:', error.message, error.cause ?? ''); return undefined; });
    // Adyen errors are JSON ({ status, errorCode, message, errorType, pspReference }); anything else (e.g. a proxy page) is logged raw.
    if (response && !response.ok) {
      const text = await response.text().catch(() => '');
      let body: unknown = text.slice(0, 1000);
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      console.error(`[adyen] /sessions HTTP ${response.status} pspReference=${response.headers.get('pspreference') ?? 'none'}`, body);
    }
    if (!response?.ok) throw new CommerceError(502, 'PaymentSessionFailed', 'Unable to start payment with Adyen');
    const session = z.object({ id: z.string().min(1), sessionData: z.string().min(1) }).parse(await response.json());
    this.transactions.save({ cartId, payment_ref_id: paymentRefId, transaction_token: session.id, storeKey, amount: { currencyCode: total.currencyCode, centAmount: total.centAmount }, status: 'INITIATED' });
    return { paymentRefId, sessionId: session.id, sessionData: session.sessionData };
  }

  // Step 5: the storefront polls this; once payment is confirmed the Order is created exactly once.
  async paymentStatus(storeKey: string, paymentRefId: string, sessionResult?: string, customer?: SessionCustomer) {
    const txn = this.transactions.find(paymentRefId);
    if (!txn || txn.storeKey !== storeKey) throw new CommerceError(404, 'PaymentNotFound', 'Payment not found');
    // Adyen appends sessionResult to our returnUrl; trading it for the session result gives the payment's pspReference.
    if (sessionResult && !txn.transaction_id) {
      txn.transaction_id = await this.adyenPspReference(txn.transaction_token, sessionResult);
      if (txn.transaction_id) this.transactions.save(txn);
    }
    if (txn.order) return { status: 'paid', order: txn.order };
    if (txn.status === 'REFUSED' || txn.status === 'EXPIRED' || txn.status === 'CANCELLED') return { status: 'failed' };
    if (txn.status === 'INITIATED' || txn.status === 'PENDING') {
      // ponytail: simulated AUTHORISATION webhook — any return from Drop-in counts as held after the delay, even a refusal. Real fix: the HMAC webhook (handlePaymentWebhook) or GET /sessions/{id}?sessionResult=.
      txn.firstPolledAt ??= Date.now();
      if (Date.now() - txn.firstPolledAt < this.config.PAYMENT_SIMULATED_DELAY_MS) { this.transactions.save(txn); return { status: 'pending' }; }
      txn.status = 'AUTHORISED'; this.transactions.save(txn);
    }
    // Concurrent polls share one order creation so the cart is never ordered twice.
    let pending = this.ordering.get(paymentRefId);
    if (!pending) {
      pending = this.createPaidOrder(txn, customer).finally(() => this.ordering.delete(paymentRefId));
      this.ordering.set(paymentRefId, pending);
    }
    return { status: 'paid', order: await pending };
  }

  // GET /sessions/{id}?sessionResult= → { status, reference, payments: [{ pspReference, resultCode, amount, paymentMethod }] }.
  // Best effort: on any failure it logs and returns undefined, and the next poll tries again.
  private async adyenPspReference(sessionId: string, sessionResult: string) {
    const response = await this.fetcher(`${ADYEN_CHECKOUT_URL}/sessions/${encodeURIComponent(sessionId)}?sessionResult=${encodeURIComponent(sessionResult)}`, {
      redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'X-API-Key': this.config.ADYEN_API_KEY ?? '' },
    }).catch((error: Error) => { console.error('[adyen] session result network error:', error.message, error.cause ?? ''); return undefined; });
    if (!response) return undefined;
    const text = await response.text().catch(() => '');
    if (!response.ok) { console.error(`[adyen] session result HTTP ${response.status}`, text.slice(0, 1000)); return undefined; }
    const result = z.object({ payments: z.array(z.object({ pspReference: z.string().min(1) })).optional() }).safeParse(JSON.parse(text || '{}'));
    return result.success ? result.data.payments?.[0]?.pspReference : undefined;
  }

  private async createPaidOrder(txn: Transaction, customer?: SessionCustomer) {
    const { cart, raw } = await this.getCheckoutCart(txn.storeKey, txn.cartId, customer);
    const total = cart.taxedPrice?.totalGross ?? cart.totalPrice;
    if (total.centAmount !== txn.amount.centAmount || total.currencyCode !== txn.amount.currencyCode) {
      throw new CommerceError(409, 'CartChangedAfterPayment', 'The cart total changed after payment started; contact support');
    }
    // The commercetools Payment must exist (and sit on the cart) before the order, so the order carries it.
    const paymentId = await this.ensureCtPayment(txn);
    const version = raw.paymentInfo?.payments.some(p => p.id === paymentId) ? cart.version
      : cartSchema.parse(await this.postCart(txn.cartId, cart.version, [{ action: 'addPayment', payment: { typeId: 'payment', id: paymentId } }])).version;
    const order = await this.ct(this.api.orders().post({ body: {
      id: txn.cartId, version, orderNumber: `SO-${randomBytes(5).toString('hex').toUpperCase()}`, paymentState: 'Pending',
      custom: { type: { typeId: 'type', key: ORDER_PAYMENT_TYPE_KEY }, fields: { internal_payment_ref_id: txn.payment_ref_id } },
    } }), (status, error) =>
      status === 409 ? new CommerceError(409, 'ConcurrentModification', 'Cart changed; refresh and try again')
        : status === 429 ? new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later')
        : new CommerceError(502, 'OrderFailed', `Unable to place order${codesOf(error).length ? `: ${codesOf(error).join(', ')}` : ''}`));
    txn.order = { id: order.id, orderNumber: order.orderNumber, totalPrice: order.taxedPrice?.totalGross ?? order.totalPrice };
    this.transactions.save(txn);
    return txn.order;
  }

  // Creates the commercetools Payment once (key = payment_ref_id), with the hold as its Authorization transaction.
  private async ensureCtPayment(txn: Transaction) {
    if (txn.ct_payment_id) return txn.ct_payment_id;
    const psp = pspOf(txn), amount = { currencyCode: txn.amount.currencyCode, centAmount: txn.amount.centAmount };
    const fail = (status: number, error: unknown) => status === 400 && codesOf(error).includes('DuplicateField')
      ? new CommerceError(409, 'PaymentExists', '') : new CommerceError(502, 'PaymentRecordFailed', 'Unable to record the payment in commerce');
    const payment = await this.ct(this.api.payments().post({ body: {
      key: txn.payment_ref_id, amountPlanned: amount, interfaceId: psp,
      paymentMethodInfo: { paymentInterface: 'adyen', method: txn.payment_method, name: { en: txn.payment_method ?? 'Adyen' } },
      paymentStatus: { interfaceCode: txn.status, interfaceText: STATUS_TEXT[txn.status] },
      transactions: [{ type: 'Authorization', amount, state: 'Success', interactionId: psp, timestamp: new Date().toISOString() }],
    } }), fail).catch(async error => {
      // An earlier attempt created it but stopped before saving the id: reuse it.
      if (error instanceof CommerceError && error.code === 'PaymentExists') return this.ct(this.api.payments().withKey({ key: txn.payment_ref_id }).get());
      throw error;
    });
    txn.ct_payment_id = payment.id; this.transactions.save(txn);
    return payment.id;
  }

  // Mirrors our status onto the commercetools Payment (status + transactions) and the order's paymentState.
  // Best effort: our payments record is the source of truth; a failed update is logged, not fatal.
  private async syncCtPayment(txn: Transaction, change?: { op: Pick<PaymentOperation, 'type' | 'pspReference' | 'amount'>; failed?: boolean }) {
    if (txn.ct_payment_id) {
      try {
        const payment = await this.ct(this.api.payments().withId({ ID: txn.ct_payment_id }).get());
        const actions: PaymentUpdateAction[] = [
          { action: 'setStatusInterfaceCode', interfaceCode: txn.status },
          { action: 'setStatusInterfaceText', interfaceText: STATUS_TEXT[txn.status] },
        ];
        const existing = change && payment.transactions.find(t => t.interactionId === change.op.pspReference);
        if (change?.failed && existing) actions.push({ action: 'changeTransactionState', transactionId: existing.id, state: 'Failure' });
        if (change && !change.failed && !existing) actions.push({ action: 'addTransaction', transaction: {
          type: CT_TRANSACTION[change.op.type], interactionId: change.op.pspReference, state: 'Success', timestamp: new Date().toISOString(),
          amount: { currencyCode: txn.amount.currencyCode, centAmount: change.op.amount ?? txn.amount.centAmount },
        } });
        await this.ct(this.api.payments().withId({ ID: txn.ct_payment_id }).post({ body: { version: payment.version, actions } }));
      } catch (error) { console.error(`[commercetools] could not update payment ${txn.ct_payment_id} to ${txn.status}:`, (error as Error).message); }
    }
    const state = ORDER_PAYMENT_STATE[txn.status];
    if (txn.order && state) await this.setOrderPaymentState(txn.order.id, state);
  }

  // Step 4: Adyen webhooks. Not reachable on localhost; the simulated path in paymentStatus covers AUTHORISATION for the POC.
  handlePaymentWebhook(body: unknown) {
    if (!this.config.ADYEN_HMAC_KEY) throw new CommerceError(503, 'WebhookNotConfigured', 'Set ADYEN_HMAC_KEY');
    const items = (body as { notificationItems?: Array<{ NotificationRequestItem?: AdyenNotificationItem }> })?.notificationItems?.map(i => i.NotificationRequestItem);
    if (!items?.length || items.some(item => !item?.amount || !validAdyenHmac(item, this.config.ADYEN_HMAC_KEY!))) {
      throw new CommerceError(401, 'InvalidSignature', 'Invalid webhook signature');
    }
    for (const item of items as AdyenNotificationItem[]) {
      // Modifications carry the reference we sent (PAY-…:CAPTURE:1); the payment's own reference is the part before ':'.
      const txn = this.transactions.find(item.merchantReference.split(':')[0]!);
      if (!txn) continue;
      txn.eventCode = item.eventCode; txn.payment_method = item.paymentMethod ?? txn.payment_method;
      const ok = item.success === 'true';
      if (item.eventCode === 'AUTHORISATION') {
        const matches = item.amount.value === txn.amount.centAmount && item.amount.currency === txn.amount.currencyCode;
        if ((txn.status === 'INITIATED' || txn.status === 'PENDING') && matches) {
          Object.assign(txn, ok ? { status: 'AUTHORISED', pspReference: item.pspReference } : { status: 'REFUSED', failure_reason: item.reason });
        }
      } else {
        const type = ({ CAPTURE: 'CAPTURE', CAPTURE_FAILED: 'CAPTURE', REFUND: 'REFUND', REFUND_FAILED: 'REFUND', CANCELLATION: 'CANCEL' } as const)[item.eventCode as 'CAPTURE'];
        const failed = !ok || item.eventCode.endsWith('_FAILED');
        const op = type && { type, pspReference: item.pspReference, amount: item.amount.value };
        if (op && this.settleOperation(txn, op, failed, item.reason)) { this.transactions.save(txn); void this.syncCtPayment(txn, { op, failed }); }
      }
      this.transactions.save(txn);
    }
    return '[accepted]';
  }

  // Confirms or reverts a modification. One that Adyen reports but we never requested (e.g. made by OrderIQ) is applied once.
  // Returns false when nothing changed (a repeat), so callers skip the commercetools update.
  private settleOperation(txn: Transaction, op: Pick<PaymentOperation, 'type' | 'pspReference' | 'amount'>, failed: boolean, reason?: string) {
    txn.operations ??= [];
    const known = txn.operations.find(o => o.pspReference === op.pspReference);
    if (known && known.status !== 'REQUESTED') return false; // repeat webhook
    if (!known) {
      if (failed) return false;
      this.applyOperation(txn, op);
      txn.operations.push({ ...op, status: 'SUCCEEDED', requestedAt: new Date().toISOString() });
      return true;
    }
    known.status = failed ? 'FAILED' : 'SUCCEEDED';
    if (!failed) return true;
    known.reason = reason; txn.failure_reason = reason;
    if (known.type === 'CAPTURE') Object.assign(txn, { status: 'AUTHORISED', captured_amount: 0 });
    if (known.type === 'CANCEL') txn.status = 'AUTHORISED';
    if (known.type === 'REFUND') { txn.refunded_amount = (txn.refunded_amount ?? 0) - (known.amount ?? 0); this.refundStatus(txn); }
    return true;
  }

  private applyOperation(txn: Transaction, op: Pick<PaymentOperation, 'type' | 'amount'>) {
    if (op.type === 'CAPTURE') Object.assign(txn, { status: 'CAPTURED', captured_amount: op.amount });
    if (op.type === 'CANCEL') txn.status = 'CANCELLED';
    if (op.type === 'REFUND') { txn.refunded_amount = (txn.refunded_amount ?? 0) + (op.amount ?? 0); this.refundStatus(txn); }
  }

  private refundStatus(txn: Transaction) {
    const refunded = txn.refunded_amount ?? 0;
    txn.status = refunded <= 0 ? 'CAPTURED' : refunded >= (txn.captured_amount ?? 0) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }

  // Payment admin (orders page). Guarded by ADMIN_API_KEY; OrderIQ will own these calls in production.
  private requireAdmin(key: string | undefined) {
    const expected = this.config.ADMIN_API_KEY;
    if (!expected) throw new CommerceError(503, 'AdminNotConfigured', 'Set ADMIN_API_KEY');
    const given = Buffer.from(key ?? ''), wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new CommerceError(401, 'Unauthorized', 'Invalid admin key');
  }

  listPayments(adminKey: string | undefined) {
    this.requireAdmin(adminKey);
    const payments = this.transactions.list().map(t => ({
      paymentRef: t.payment_ref_id, status: t.status, currency: t.amount.currencyCode, amount: t.amount.centAmount,
      capturedAmount: t.captured_amount ?? 0, refundedAmount: t.refunded_amount ?? 0, paymentMethod: t.payment_method,
      pspReference: pspOf(t), orderNumber: t.order?.orderNumber, failureReason: t.failure_reason,
      operations: t.operations ?? [], createdAt: t.created_at, updatedAt: t.updated_at,
    })).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { payments };
  }

  async modifyPayment(adminKey: string | undefined, paymentRefId: string, type: PaymentOperation['type'], amount?: number) {
    this.requireAdmin(adminKey);
    const txn = this.transactions.find(paymentRefId);
    if (!txn) throw new CommerceError(404, 'PaymentNotFound', 'Payment not found');
    const psp = pspOf(txn);
    if (!psp) throw new CommerceError(409, 'NoPspReference', 'Adyen has not confirmed this payment yet');
    const captured = txn.captured_amount ?? 0, refunded = txn.refunded_amount ?? 0;
    const allowed = type === 'REFUND' ? txn.status === 'CAPTURED' || txn.status === 'PARTIALLY_REFUNDED' : txn.status === 'AUTHORISED';
    if (!allowed) throw new CommerceError(409, 'InvalidPaymentState', `Cannot ${type.toLowerCase()} a payment that is ${txn.status}`);
    const value = type === 'CANCEL' ? undefined : amount ?? (type === 'CAPTURE' ? txn.amount.centAmount : captured - refunded);
    const max = type === 'CAPTURE' ? txn.amount.centAmount : captured - refunded;
    if (value !== undefined && (value <= 0 || value > max)) throw new CommerceError(422, 'InvalidAmount', `Amount must be between 1 and ${max}`);
    if (this.modifying.has(paymentRefId)) throw new CommerceError(409, 'OperationInProgress', 'Another operation on this payment is in progress');
    this.modifying.add(paymentRefId);
    try {
      const n = (txn.operations ?? []).filter(o => o.type === type).length + 1;
      const reference = `${paymentRefId}:${type}:${n}`;
      const path = { CAPTURE: 'captures', REFUND: 'refunds', CANCEL: 'cancels' }[type];
      const response = await this.fetcher(`${ADYEN_CHECKOUT_URL}/payments/${encodeURIComponent(psp)}/${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'X-API-Key': this.config.ADYEN_API_KEY ?? '', 'Content-Type': 'application/json', 'Idempotency-Key': reference },
        body: JSON.stringify({ merchantAccount: this.config.ADYEN_MERCHANT_ACCOUNT, reference, ...(value !== undefined && { amount: { value, currency: txn.amount.currencyCode } }) }),
      }).catch((error: Error) => { console.error(`[adyen] ${path} network error:`, error.message, error.cause ?? ''); return undefined; });
      const text = await response?.text().catch(() => '') ?? '';
      if (!response?.ok) {
        console.error(`[adyen] ${path} HTTP ${response?.status ?? 'none'}`, text.slice(0, 1000));
        throw new CommerceError(502, 'PaymentModificationFailed', `Adyen did not accept the ${type.toLowerCase()}`);
      }
      // Adyen answers "received"; the outcome arrives later as a webhook, which can still revert this (settleOperation).
      const { pspReference } = z.object({ pspReference: z.string().min(1) }).parse(JSON.parse(text));
      const fresh = this.transactions.find(paymentRefId)!;
      this.applyOperation(fresh, { type, amount: value });
      (fresh.operations ??= []).push({ type, pspReference, amount: value, status: 'REQUESTED', requestedAt: new Date().toISOString() });
      this.transactions.save(fresh);
      await this.syncCtPayment(fresh, { op: { type, pspReference, amount: value } });
      return this.listPayments(adminKey).payments.find(p => p.paymentRef === paymentRefId);
    } finally { this.modifying.delete(paymentRefId); }
  }

  // Best effort: the payment record is the source of truth; a failed commercetools update is logged, not fatal.
  private async setOrderPaymentState(orderId: string, paymentState: 'Paid' | 'Pending' | 'Failed') {
    try {
      const order = await this.ct(this.api.orders().withId({ ID: orderId }).get());
      await this.ct(this.api.orders().withId({ ID: orderId }).post({ body: { version: order.version, actions: [{ action: 'changePaymentState', paymentState }] } }));
    } catch (error) { console.error(`[commercetools] could not set order ${orderId} paymentState=${paymentState}:`, (error as Error).message); }
  }

  async createCheckoutSession(storeKey: string, cartId: string, customer?: SessionCustomer) {
    if (!this.config.CT_CHECKOUT_SESSION_URL || !this.config.CT_CHECKOUT_APPLICATION_KEY) {
      throw new CommerceError(503, 'CheckoutNotConfigured', 'Set CT_CHECKOUT_SESSION_URL and CT_CHECKOUT_APPLICATION_KEY');
    }
    const { cart, raw } = await this.getCheckoutCart(storeKey, cartId, customer);
    if (!cart.lineItems.length) throw new CommerceError(400, 'EmptyCart', 'Add at least one product before checkout');
    if (!raw.shippingAddress || !raw.billingAddress || !raw.shippingInfo) {
      throw new CommerceError(400, 'CheckoutNotReady', 'Enter an address and select a shipping method before payment');
    }
    // The Checkout Session API is not part of the Platform SDK; reuse the SDK's cached token
    // (getCheckoutCart above just made sure it is fresh).
    const sessionResponse = await this.fetcher(`${origin(this.config.CT_CHECKOUT_SESSION_URL)}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}/sessions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.tokenStore.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart: { cartRef: { id: cartId } }, metadata: { applicationKey: this.config.CT_CHECKOUT_APPLICATION_KEY } }),
    });
    if (!sessionResponse.ok) throw new CommerceError(502, 'CheckoutSessionFailed', 'Unable to create Checkout Session');
    const result = z.object({ id: z.string().min(1) }).parse(await sessionResponse.json());
    // The browser SDK needs the project and region; derive them here so the storefront hard-codes neither.
    const region = new URL(this.config.CT_CHECKOUT_SESSION_URL).hostname.replace(/^session\./, '').replace(/\.commercetools\.com$/, '');
    return { sessionId: result.id, projectKey: this.config.CT_PROJECT_KEY, region };
  }

  async createCustomer(input: CustomerInput): Promise<CustomerResult> {
    // Explicit allowlist: passwords, verification flags, and identity IDs cannot be supplied by callers.
    const draft = { email: input.email, firstName: input.firstName, lastName: input.lastName, authenticationMode: 'ExternalAuth' as const };
    return this.createDraft(draft);
  }

  private async createDraft(draft: CustomerDraft): Promise<CustomerResult> {
    // Strip unknown upstream fields, including any sensitive fields.
    return customerResult.parse(await this.ct(this.api.customers().post({ body: draft }), (status, error) => {
      if (status === 409 || codesOf(error).includes('DuplicateField')) return new CommerceError(409, 'CustomerAlreadyExists', 'A customer with this email already exists');
      if (status === 429) return new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later');
      return new CommerceError(502, 'CommerceRequestFailed', 'Unable to create customer in commerce service');
    }));
  }

  // commercetools issues the token; delivering it to the customer is the caller's job.
  async createPasswordToken(email: string): Promise<string | undefined> {
    try { return (await this.api.customers().passwordToken().post({ body: { email: email.toLowerCase(), ttlMinutes: 30 } }).execute()).body.value; }
    catch (error) {
      const status = statusOf(error);
      if (status === 400 || status === 404) return undefined; // unknown email; never reveal that to callers
      throw status === 429 ? new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later') : new CommerceError(502, 'CommerceRequestFailed', 'Unable to start password reset');
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    await this.ct(this.api.customers().passwordReset().post({ body: { tokenValue: token, newPassword } }), status =>
      status === 400 || status === 404 ? new CommerceError(400, 'InvalidResetToken', 'This reset link is invalid or has expired')
        : status === 429 ? new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later')
        : new CommerceError(502, 'CommerceRequestFailed', 'Unable to reset password'));
  }

  registerCustomer(input: RegisterInput): Promise<CustomerResult> {
    return this.createDraft({ email: input.email.toLowerCase(), password: input.password, firstName: input.firstName, lastName: input.lastName });
  }

  async loginCustomer(email: string, password: string): Promise<CustomerResult> {
    email = email.toLowerCase();
    const fail = (status: number, error: unknown) => {
      console.error(`[login] commercetools rejected sign-in: status=${status} codes=${codesOf(error).join(',') || 'none'}`);
      if (codesOf(error).includes('InvalidCredentials')) return new CommerceError(401, 'InvalidCredentials', 'Email or password is incorrect');
      if (status === 429) return new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later');
      return new CommerceError(502, 'CommerceRequestFailed', 'Unable to sign in');
    };
    try { return customerResult.parse(await this.ct(this.api.login().post({ body: { email, password } }), fail)); }
    catch (error) {
      if ((error as CommerceError).code !== 'InvalidCredentials') throw error;
      // Checkout adds the customer to a Store (createStoreCart). commercetools rejects the global /login for
      // Store-scoped customers, so retry through each of their Stores before reporting bad credentials.
      const found = await this.ct(this.api.customers().get({ queryArgs: { where: `email=${JSON.stringify(email)}`, limit: 1 } }), failWith('Unable to sign in'));
      for (const store of found.results[0]?.stores ?? []) {
        try { return customerResult.parse(await this.ct(this.store(store.key).login().post({ body: { email, password } }), fail)); }
        catch (storeError) { if ((storeError as CommerceError).code !== 'InvalidCredentials') throw storeError; }
      }
      throw error;
    }
  }

  private async findCustomer(field: 'key' | 'email', value: string): Promise<z.infer<typeof customerSchema> | undefined> {
    const body = await this.ct(this.api.customers().get({ queryArgs: { where: `${field}=${JSON.stringify(value)}`, limit: 2 } }), failWith('Unable to retrieve commerce customer'));
    // Check authenticationMode before parsing so password customers cannot be linked.
    if (body.results.length > 1) throw new CommerceError(409, 'AccountLinkRequired', 'Customer identity needs manual review');
    const customer = body.results[0];
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
      const updated = await this.ct(this.api.customers().withId({ ID: existing.id }).post({ body: { version: existing.version, actions: [{ action: 'setKey', key }] } }), status =>
        status === 409 ? new CommerceError(409, 'CustomerAlreadyExists', 'Customer changed during login') : new CommerceError(502, 'CommerceRequestFailed', 'Unable to link commerce customer'));
      return { customer: customerSchema.parse(updated) };
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
