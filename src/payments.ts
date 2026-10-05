import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Money = { currencyCode: string; centAmount: number };
export type Transaction = {
  cartId: string; payment_ref_id: string; transaction_token: string;
  storeKey: string; amount: Money; status: 'pending' | 'paid';
  firstPolledAt?: number; pspReference?: string;
  // From the latest verified Adyen webhook for this payment.
  payment_method?: string; eventCode?: string;
  order?: { id: string; orderNumber?: string; totalPrice: Money };
};

// ponytail: JSON file stands in for a database (POC only); sync I/O keeps writes ordered in one process. Swap for a table when there is more than one BFF instance.
export class TransactionStore {
  constructor(private readonly path: string) {}
  private read(): Transaction[] {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as { transactions: Transaction[] }).transactions : [];
  }
  find(paymentRefId: string) { return this.read().find(t => t.payment_ref_id === paymentRefId); }
  save(txn: Transaction) {
    const transactions = this.read().filter(t => t.payment_ref_id !== txn.payment_ref_id);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ transactions: [...transactions, txn] }, null, 2));
    return txn;
  }
}

// Adyen standard-notification HMAC: https://docs.adyen.com/development-resources/webhooks/verify-hmac-signatures
export type AdyenNotificationItem = {
  pspReference: string; originalReference?: string; merchantAccountCode: string; merchantReference: string;
  amount: { value: number; currency: string }; eventCode: string; success: string; paymentMethod?: string; additionalData?: { hmacSignature?: string };
};
export function validAdyenHmac(item: AdyenNotificationItem, hexKey: string) {
  const payload = [item.pspReference, item.originalReference ?? '', item.merchantAccountCode, item.merchantReference,
    item.amount.value, item.amount.currency, item.eventCode, item.success].join(':');
  const expected = createHmac('sha256', Buffer.from(hexKey, 'hex')).update(payload).digest();
  const given = Buffer.from(item.additionalData?.hmacSignature ?? '', 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
