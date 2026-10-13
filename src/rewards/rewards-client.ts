import { z } from 'zod';
import type { Config } from '../config.js';
import { CommerceError } from '../commercetools.js';
import type { SessionCustomer } from '../sessions.js';
import type { RewardRuleInput, RewardService } from './rewards.js';

const ruleValue = z.object({ name: z.string(), eligibleSkus: z.array(z.string()), requiredQuantity: z.number().int().positive(), points: z.number().int().positive(), repeat: z.boolean(), active: z.boolean() });
const customObject = z.object({ id: z.string(), version: z.number().int().positive(), key: z.string(), value: z.unknown() });

export function calculateRewardPoints(rules: Array<RewardRuleInput & { key: string }>, items: Array<{ sku?: string; quantity: number }>) {
  const awardedRules: Array<{ key: string; occurrences: number; points: number }> = [];
  let points = 0;
  for (const rule of rules.filter(item => item.active)) {
    const eligible = new Set(rule.eligibleSkus);
    const quantity = items.reduce((sum, item) => sum + (item.sku && eligible.has(item.sku) ? item.quantity : 0), 0);
    const occurrences = rule.repeat ? Math.floor(quantity / rule.requiredQuantity) : quantity >= rule.requiredQuantity ? 1 : 0;
    if (occurrences > 0) { const earned = occurrences * rule.points; points += earned; awardedRules.push({ key: rule.key, occurrences, points: earned }); }
  }
  return { points, awardedRules };
}

export class CommercetoolsRewardClient implements RewardService {
  private token?: { value: string; expiresAt: number };
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}

  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const response = await this.fetcher(`${this.config.CT_AUTH_URL.replace(/\/$/, '')}/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${this.config.CT_CLIENT_ID}:${this.config.CT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.config.CT_SCOPES }) });
    if (!response.ok) throw new CommerceError(502, 'CommerceAuthenticationFailed', 'Unable to authenticate with commerce service');
    const result = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await response.json());
    this.token = { value: result.access_token, expiresAt: Date.now() + Math.max(0, result.expires_in - 60) * 1000 };
    return result.access_token;
  }

  private async commerce(path: string, init: RequestInit = {}) {
    return this.fetcher(`${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}${path}`, { ...init, headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  }

  private async error(response: Response, fallback: string): Promise<never> {
    let message = fallback;
    try { message = z.object({ message: z.string().optional() }).parse(await response.json()).message ?? fallback; } catch { /* safe fallback */ }
    throw new CommerceError(response.status >= 400 && response.status < 500 ? response.status : 502, 'RewardRequestFailed', message);
  }

  async listRules() {
    const query = new URLSearchParams({ where: 'container="loyalty-rules"', limit: '500', sort: 'lastModifiedAt desc' });
    const response = await this.commerce(`/custom-objects?${query}`);
    if (!response.ok) return this.error(response, 'Unable to load reward rules');
    const result = z.object({ results: z.array(customObject) }).parse(await response.json());
    return { rules: result.results.map(item => ({ ...ruleValue.parse(item.value), key: item.key })) };
  }

  async saveRule(input: RewardRuleInput) {
    const value = { ...input, eligibleSkus: [...new Set(input.eligibleSkus.map(sku => sku.trim()))] };
    const response = await this.commerce('/custom-objects', { method: 'POST', body: JSON.stringify({ container: 'loyalty-rules', key: input.key, value }) });
    if (!response.ok) return this.error(response, 'Unable to save reward rule');
    return { rule: value };
  }

  async removeRule(key: string) {
    const current = await this.commerce(`/custom-objects/loyalty-rules/${encodeURIComponent(key)}`);
    if (current.status === 404) throw new CommerceError(404, 'RewardRuleNotFound', 'Reward rule was not found');
    if (!current.ok) return this.error(current, 'Unable to read reward rule');
    const item = customObject.parse(await current.json());
    const response = await this.commerce(`/custom-objects/loyalty-rules/${encodeURIComponent(key)}?version=${item.version}`, { method: 'DELETE' });
    if (!response.ok) return this.error(response, 'Unable to remove reward rule');
    return { removed: true, key };
  }

  async balance(customer: SessionCustomer) {
    const response = await this.commerce(`/customers/${encodeURIComponent(customer.id)}`);
    if (!response.ok) return this.error(response, 'Unable to read reward balance');
    const result = z.object({ custom: z.object({ fields: z.record(z.string(), z.unknown()) }).optional() }).parse(await response.json());
    const value = result.custom?.fields.rewardPointsBalance;
    return { balance: typeof value === 'number' && Number.isFinite(value) ? value : 0 };
  }

  async previewCart(cartId: string, customer: SessionCustomer) {
    const response = await this.commerce(`/carts/${encodeURIComponent(cartId)}`);
    if (response.status === 404) throw new CommerceError(404, 'CartNotFound', 'Cart not found');
    if (!response.ok) return this.error(response, 'Unable to read cart rewards');
    const cart = z.object({
      customerId: z.string().optional(), customerEmail: z.string().optional(),
      lineItems: z.array(z.object({ quantity: z.number().int().positive(), variant: z.object({ sku: z.string().optional() }) })),
    }).parse(await response.json());
    if (cart.customerId !== customer.id && cart.customerEmail?.toLowerCase() !== customer.email.toLowerCase()) {
      throw new CommerceError(404, 'CartNotFound', 'Cart not found');
    }
    const { rules } = await this.listRules() as { rules: Array<RewardRuleInput & { key: string }> };
    return calculateRewardPoints(rules, cart.lineItems.map(item => ({ sku: item.variant.sku, quantity: item.quantity })));
  }

  async awardOrder(orderId: string, customer: SessionCustomer) {
    const transactionKey = `reward-order-${orderId}`;
    const existing = await this.commerce(`/custom-objects/loyalty-transactions/${transactionKey}`);
    let existingTransaction: z.infer<typeof customObject> | undefined;
    if (existing.ok) {
      existingTransaction = customObject.parse(await existing.json());
      const value = z.object({ points: z.number(), balance: z.number() }).parse(existingTransaction.value);
      if (value.points > 0) return { alreadyAwarded: true, ...value, orderId };
    }
    if (!existing.ok && existing.status !== 404) return this.error(existing, 'Unable to verify reward transaction');

    const orderResponse = await this.commerce(`/orders/${encodeURIComponent(orderId)}`);
    if (orderResponse.status === 404) throw new CommerceError(404, 'OrderNotFound', 'Order not found');
    if (!orderResponse.ok) return this.error(orderResponse, 'Unable to read order');
    const order = z.object({ id: z.string(), customerId: z.string().optional(), customerEmail: z.string().optional(), lineItems: z.array(z.object({ quantity: z.number().int().positive(), variant: z.object({ sku: z.string().optional() }) })) }).parse(await orderResponse.json());
    if (order.customerId !== customer.id && order.customerEmail?.toLowerCase() !== customer.email.toLowerCase()) throw new CommerceError(404, 'OrderNotFound', 'Order not found');

    const { rules } = await this.listRules() as { rules: Array<RewardRuleInput> };
    const { points, awardedRules } = calculateRewardPoints(rules, order.lineItems.map(item => ({ sku: item.variant.sku, quantity: item.quantity })));

    const customerResponse = await this.commerce(`/customers/${encodeURIComponent(customer.id)}`);
    if (!customerResponse.ok) return this.error(customerResponse, 'Unable to read customer rewards');
    const current = z.object({ version: z.number().int().positive(), custom: z.object({ type: z.object({ key: z.string().optional() }).optional(), fields: z.record(z.string(), z.unknown()) }).optional() }).parse(await customerResponse.json());
    const oldBalance = typeof current.custom?.fields.rewardPointsBalance === 'number' ? current.custom.fields.rewardPointsBalance : 0;
    const balance = oldBalance + points;
    if (points === 0) return { alreadyAwarded: false, orderId, points, balance, awardedRules };
    const action = current.custom?.type?.key === this.config.DELIVERY_PASS_CUSTOM_TYPE_KEY
      ? { action: 'setCustomField', name: 'rewardPointsBalance', value: balance }
      : { action: 'setCustomType', type: { typeId: 'type', key: this.config.DELIVERY_PASS_CUSTOM_TYPE_KEY }, fields: { rewardPointsBalance: balance } };
    const updated = await this.commerce(`/customers/${encodeURIComponent(customer.id)}`, { method: 'POST', body: JSON.stringify({ version: current.version, actions: [action] }) });
    if (!updated.ok) return this.error(updated, 'Unable to update reward balance');
    const transaction = await this.commerce('/custom-objects', { method: 'POST', body: JSON.stringify({ container: 'loyalty-transactions', key: transactionKey, ...(existingTransaction ? { version: existingTransaction.version } : {}), value: { orderId, customerId: customer.id, points, balance, awardedRules, awardedAt: new Date().toISOString() } }) });
    if (!transaction.ok) return this.error(transaction, 'Unable to record reward transaction');
    return { alreadyAwarded: false, orderId, points, balance, awardedRules };
  }

  async reconcileLatestOrder(customer: SessionCustomer) {
    const where = `customerId="${customer.id}" or customerEmail="${customer.email.replace(/["\\]/g, '')}"`;
    const query = new URLSearchParams({ where, sort: 'createdAt desc', limit: '1' });
    const response = await this.commerce(`/orders?${query}`);
    if (!response.ok) return this.error(response, 'Unable to find the latest order');
    const result = z.object({ results: z.array(z.object({ id: z.string() })) }).parse(await response.json());
    const order = result.results[0];
    if (!order) return { reconciled: false, points: 0, ...(await this.balance(customer) as { balance: number }) };
    return { reconciled: true, ...(await this.awardOrder(order.id, customer) as object) };
  }
}
