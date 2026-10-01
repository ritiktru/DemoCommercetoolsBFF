import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// GP API (Unified Payments) over REST. Field names and headers match the official globalpayments-api SDK.
const API = { sandbox: 'https://apis.sandbox.globalpay.com/ucp', production: 'https://apis.globalpay.com/ucp' };
const tokenSchema = z.object({
  token: z.string().min(1), seconds_to_expire: z.number().int().positive().default(600),
  scope: z.object({ accounts: z.array(z.object({ id: z.string(), name: z.string() })).default([]) }).optional(),
});
const transactionSchema = z.object({
  id: z.string().regex(/^TRN_[A-Za-z0-9_-]+$/), status: z.string(),
  amount: z.coerce.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/),
  reference: z.string().optional(),
});
export type GpTransaction = z.infer<typeof transactionSchema>;
export type GpEnv = keyof typeof API;

export class GlobalPaymentsClient {
  private server?: { token: string; account: string; expires: number };
  constructor(private readonly appId: string, private readonly appKey: string, private readonly env: GpEnv, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, init: { method: string; body?: unknown; token?: string; idempotencyKey?: string }) {
    const response = await this.fetcher(`${API[this.env]}${path}`, {
      method: init.method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json', 'X-GP-Version': '2021-03-22',
        ...(init.token && { Authorization: `Bearer ${init.token}` }),
        ...(init.idempotencyKey && { 'x-gp-idempotency': init.idempotencyKey }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
    return { ok: response.ok, body: await response.json().catch(() => undefined) };
  }

  private async accessToken(seconds: number, permissions?: string[]) {
    const nonce = randomBytes(16).toString('hex');
    const secret = createHash('sha512').update(nonce + this.appKey).digest('hex');
    const { ok, body } = await this.request('/accesstoken', { method: 'POST', body: {
      app_id: this.appId, nonce, secret, grant_type: 'client_credentials', seconds_to_expire: seconds, ...(permissions && { permissions }),
    } });
    const parsed = tokenSchema.safeParse(body);
    if (!ok || !parsed.success) throw new Error('Global Payments access token request failed');
    return parsed.data;
  }

  // Handed to the browser: it can only tokenize one card, never charge or read transactions.
  async tokenizationToken() { return (await this.accessToken(600, ['PMT_POST_Create_Single'])).token; }

  private async serverToken() {
    if (this.server && this.server.expires > Date.now() + 60_000) return this.server;
    const data = await this.accessToken(3600);
    const account = data.scope?.accounts.find(a => a.id.startsWith('TRA_'))?.name;
    if (!account) throw new Error('Global Payments app has no transaction processing account');
    this.server = { token: data.token, account, expires: Date.now() + data.seconds_to_expire * 1000 };
    return this.server;
  }

  // The reference doubles as the idempotency key, so a retried charge for the same payment is never taken twice.
  async charge(input: { centAmount: number; currency: string; country: string; reference: string; cardToken: string }): Promise<GpTransaction> {
    const { token, account } = await this.serverToken();
    const { ok, body } = await this.request('/transactions', { method: 'POST', token, idempotencyKey: input.reference, body: {
      account_name: account, channel: 'CNP', type: 'SALE', capture_mode: 'AUTO',
      amount: String(input.centAmount), currency: input.currency, country: input.country, reference: input.reference,
      payment_method: { entry_mode: 'ECOM', id: input.cardToken },
    } });
    const parsed = transactionSchema.safeParse(body);
    if (!ok || !parsed.success) throw new Error('Global Payments charge failed');
    return parsed.data;
  }

  async getTransaction(id: string): Promise<GpTransaction> {
    const { token } = await this.serverToken();
    const { ok, body } = await this.request(`/transactions/${encodeURIComponent(id)}`, { method: 'GET', token });
    const parsed = transactionSchema.safeParse(body);
    if (!ok || !parsed.success) throw new Error('Global Payments transaction lookup failed');
    return parsed.data;
  }

  // X-GP-Signature is SHA-512 hex of the exact request bytes followed by the app key (GenerationUtils in the GP PHP SDK).
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) return false;
    const expected = createHash('sha512').update(rawBody).update(this.appKey).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }
}
