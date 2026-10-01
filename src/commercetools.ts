import { z } from 'zod';
import { ClientBuilder, type TokenStore } from '@commercetools/sdk-client-v2';
import { createApiBuilderFromCtpClient, type Cart, type CartUpdateAction, type ClientResponse, type CustomerDraft, type Order, type Payment } from '@commercetools/platform-sdk';
import type { Config } from './config.js';
import { createHash } from 'node:crypto';
import type { GoogleIdentity } from './google.js';
import { cartSchema, type CartInput, type CartResult, type CartService } from './carts/cart.js';
import type { SessionCustomer } from './sessions.js';
import type { AddItemInput, ChargePaymentInput, CheckoutAddressInput, DiscountCodeInput, StorefrontService, UpdateItemInput } from './storefront/storefront.js';
import { GlobalPaymentsClient, type GpTransaction } from './payments/globalpayments.js';

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
const cartTotal = (cart: Cart) => cart.taxedPrice?.totalGross ?? cart.totalPrice;
// One order per cart: commercetools rejects a duplicate orderNumber, which makes order creation idempotent.
const orderNumberFor = (cartId: string) => `SO-${createHash('sha256').update(cartId).digest('hex').slice(0, 10).toUpperCase()}`;
const chargedOf = (payment: Payment) => payment.transactions.filter(t => t.type === 'Charge' && t.state === 'Success').reduce((sum, t) => sum + t.amount.centAmount, 0);
const gpFail = () => new CommerceError(502, 'PaymentGatewayFailed', 'Payment service is unavailable; try again');
// Custom Type created in Merchant Center (resourceTypeIds: order); links the order to the payment ref issued at initiation.
const PAYMENT_REF_TYPE_KEY = 'internal-payment-reference-type';
const orderView = (order: Order) => ({ order: { id: order.id, orderNumber: order.orderNumber, totalPrice: order.taxedPrice?.totalGross ?? order.totalPrice } });

export class CommercetoolsClient implements CustomerService, CartService, StorefrontService {
  private tokenStore: TokenStore = { token: '', expirationTime: -1 };
  private readonly api;
  private readonly gp?: GlobalPaymentsClient;
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {
    if (config.GP_APP_ID && config.GP_APP_KEY) this.gp = new GlobalPaymentsClient(config.GP_APP_ID, config.GP_APP_KEY, config.GP_ENV, fetcher);
    const client = new ClientBuilder()
      .withClientCredentialsFlow({
        host: origin(config.CT_AUTH_URL), projectKey: config.CT_PROJECT_KEY,
        credentials: { clientId: config.CT_CLIENT_ID, clientSecret: config.CT_CLIENT_SECRET },
        scopes: config.CT_SCOPES.split(/\s+/), fetch: fetcher,
        tokenCache: { get: () => this.tokenStore, set: token => { this.tokenStore = token; } },
      })
      .withHttpMiddleware({ host: origin(config.CT_API_URL), fetch: fetcher, timeout: 15000, getAbortController: () => new AbortController(), enableRetry: false })
      .build();
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

  private payments() {
    if (!this.gp) throw new CommerceError(503, 'PaymentsNotConfigured', 'Set GP_APP_ID and GP_APP_KEY');
    return this.gp;
  }
  private getPayment(id: string) {
    return this.ct(this.api.payments().withId({ ID: id }).get(), status => status === 404 ? new CommerceError(404, 'PaymentNotFound', 'Payment not found') : failWith('Unable to load payment')());
  }
  private findOrder(orderNumber: string) {
    return this.ct(this.api.orders().withOrderNumber({ orderNumber }).get(), () => new CommerceError(404, 'OrderNotFound', 'Order not found')).catch(() => undefined);
  }

  // Step 1: the amount is fixed here from the commercetools cart; the browser only receives a tokenize-only access token.
  async startPayment(storeKey: string, cartId: string, customer?: SessionCustomer) {
    const gp = this.payments();
    const { cart, raw } = await this.getCheckoutCart(storeKey, cartId, customer);
    if (!cart.lineItems.length) throw new CommerceError(400, 'EmptyCart', 'Add at least one product before checkout');
    if (!raw.shippingAddress || !raw.shippingInfo) throw new CommerceError(400, 'CheckoutNotReady', 'Enter an address and select a delivery method before payment');
    const { currencyCode, centAmount } = cartTotal(raw);
    const payment = await this.ct(this.api.payments().post({ body: {
      amountPlanned: { currencyCode, centAmount },
      paymentMethodInfo: { paymentInterface: 'GlobalPayments', method: 'CreditCard' },
    } }), failWith('Unable to start payment'));
    await this.postCart(cartId, cart.version, [{ action: 'addPayment', payment: { typeId: 'payment', id: payment.id } }]);
    const accessToken = await gp.tokenizationToken().catch(() => { throw gpFail(); });
    return { paymentId: payment.id, accessToken, env: this.config.GP_ENV, amount: { currencyCode, centAmount } };
  }

  // Step 2: charge the single-use card token server-to-server, then turn the cart into a paid order.
  async chargePayment(storeKey: string, input: ChargePaymentInput, customer?: SessionCustomer) {
    const gp = this.payments();
    const { raw } = await this.getCheckoutCart(storeKey, input.cartId, customer);
    if (!raw.paymentInfo?.payments.some(p => p.id === input.paymentId)) throw new CommerceError(404, 'PaymentNotFound', 'Payment not found');
    const payment = await this.getPayment(input.paymentId);
    if (!chargedOf(payment)) {
      const total = cartTotal(raw);
      if (total.centAmount !== payment.amountPlanned.centAmount || total.currencyCode !== payment.amountPlanned.currencyCode) {
        throw new CommerceError(409, 'CartChanged', 'Your cart changed after payment started; start payment again');
      }
      const transaction = await gp.charge({
        centAmount: total.centAmount, currency: total.currencyCode, country: raw.country ?? 'CA',
        reference: payment.id, cardToken: input.cardToken,
      }).catch(() => { throw gpFail(); });
      await this.recordTransaction(payment, transaction);
      if (transaction.status !== 'CAPTURED') throw new CommerceError(402, 'PaymentDeclined', 'Your card was declined; try another card');
    }
    return this.settle(input.cartId, payment.id);
  }

  // Step 3 (server to server): Global Payments notifies us; only the transaction ID is taken from the body,
  // everything else is read back from Global Payments so a forged or replayed body cannot create an order.
  async handlePaymentWebhook(rawBody: Buffer | undefined, signature: string | undefined, body: unknown) {
    const gp = this.payments();
    if (!rawBody || !gp.verifySignature(rawBody, signature)) throw new CommerceError(401, 'InvalidSignature', 'Invalid webhook signature');
    const notice = z.object({ id: z.string().regex(/^TRN_[A-Za-z0-9_-]+$/) }).safeParse(body);
    if (!notice.success) return { received: true };
    const transaction = await gp.getTransaction(notice.data.id).catch(() => { throw gpFail(); });
    if (!z.uuid().safeParse(transaction.reference).success) return { received: true };
    const payment = await this.getPayment(transaction.reference!).catch(error => { if (error instanceof CommerceError && error.status === 404) return undefined; throw error; });
    if (payment?.paymentMethodInfo.paymentInterface !== 'GlobalPayments') return { received: true };
    await this.recordTransaction(payment, transaction);
    if (transaction.status !== 'CAPTURED') return { received: true };
    const carts = await this.ct(this.api.carts().get({ queryArgs: { where: `paymentInfo(payments(id="${payment.id}"))`, limit: 1 } }), failWith('Unable to load cart for payment'));
    if (carts.results[0]) await this.settle(carts.results[0].id, payment.id);
    return { received: true };
  }

  private async recordTransaction(payment: Payment, transaction: GpTransaction): Promise<void> {
    if (payment.transactions.some(t => t.interactionId === transaction.id)) return;
    try {
      await this.ct(this.api.payments().withId({ ID: payment.id }).post({ body: { version: payment.version, actions: [{ action: 'addTransaction', transaction: {
        type: 'Charge', interactionId: transaction.id, state: transaction.status === 'CAPTURED' ? 'Success' : 'Failure',
        amount: { currencyCode: transaction.currency, centAmount: transaction.amount },
      } }] } }), status => status === 409 ? new CommerceError(409, 'ConcurrentModification', '') : failWith('Unable to record payment')());
    } catch (error) {
      // The charge response and the webhook can race on the same Payment; re-read and try again.
      if (error instanceof CommerceError && error.status === 409) return this.recordTransaction(await this.getPayment(payment.id), transaction);
      throw error;
    }
  }

  // Idempotent: the charge response and the webhook both call this; the deterministic orderNumber lets only one order exist.
  private async settle(cartId: string, paymentId: string) {
    const orderNumber = orderNumberFor(cartId);
    const existing = await this.findOrder(orderNumber);
    if (existing) return orderView(existing);
    const [cart, payment] = await Promise.all([
      this.ct(this.api.carts().withId({ ID: cartId }).get(), () => new CommerceError(404, 'CartNotFound', 'Cart not found')),
      this.getPayment(paymentId),
    ]);
    const total = cartTotal(cart);
    if (!cart.paymentInfo?.payments.some(p => p.id === paymentId) || chargedOf(payment) !== total.centAmount || payment.amountPlanned.currencyCode !== total.currencyCode) {
      // ponytail: money is captured but does not match the cart; needs a refund or manual review, not automated yet.
      throw new CommerceError(409, 'PaymentMismatch', 'Payment does not match the cart total; contact support');
    }
    try {
      return orderView(await this.ct(this.api.orders().post({ body: {
        id: cartId, version: cart.version, orderNumber, paymentState: 'Paid',
        custom: { type: { typeId: 'type', key: PAYMENT_REF_TYPE_KEY }, fields: { internal_payment_ref_id: paymentId } },
      } }), (status, error) =>
        status === 409 ? new CommerceError(409, 'ConcurrentModification', 'Cart changed; refresh and try again')
          : status === 429 ? new CommerceError(503, 'CommerceBusy', 'Commerce service is busy; try again later')
          : new CommerceError(502, 'OrderFailed', `Unable to place order${codesOf(error).length ? `: ${codesOf(error).join(', ')}` : ''}`)));
    } catch (error) {
      const raced = await this.findOrder(orderNumber);
      if (raced) return orderView(raced);
      throw error;
    }
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
