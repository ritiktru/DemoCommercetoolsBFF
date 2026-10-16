import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Money = { currencyCode: string; centAmount: number };
// INITIATED → PENDING → AUTHORISED (money held) → CAPTURED → PARTIALLY_REFUNDED → REFUNDED; REFUSED, EXPIRED, CANCELLED end it.
export type PaymentStatus = 'INITIATED' | 'PENDING' | 'AUTHORISED' | 'REFUSED' | 'EXPIRED' | 'CAPTURED' | 'CANCELLED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
// One Adyen modification. Its effect is applied when Adyen accepts the request; a later *_FAILED webhook reverts it.
export type PaymentOperation = {
  type: 'CAPTURE' | 'REFUND' | 'CANCEL'; pspReference: string; amount?: number;
  status: 'REQUESTED' | 'SUCCEEDED' | 'FAILED'; reason?: string; requestedAt: string;
};
export type Transaction = {
  cartId: string; payment_ref_id: string; transaction_token: string;
  storeKey: string; amount: Money; status: PaymentStatus;
  captured_amount?: number; refunded_amount?: number; failure_reason?: string;
  firstPolledAt?: number; pspReference?: string;
  // Adyen pspReference read from the session result when the shopper finishes in Drop-in.
  transaction_id?: string;
  // From the latest verified Adyen webhook for this payment.
  payment_method?: string; eventCode?: string;
  operations?: PaymentOperation[];
  order?: { id: string; orderNumber?: string; totalPrice: Money };
  // commercetools Payment linked to the order; created when the order is.
  ct_payment_id?: string;
  created_at?: string; updated_at?: string;
};
// Rows written before the status model used lowercase pending/paid.
const LEGACY_STATUS: Record<string, PaymentStatus> = { pending: 'INITIATED', paid: 'AUTHORISED' };
export const pspOf = (txn: Transaction) => txn.pspReference ?? txn.transaction_id;

// ponytail: JSON file stands in for a database (POC only); sync I/O keeps writes ordered in one process. Swap for a table when there is more than one BFF instance.
export class TransactionStore {
  constructor(private readonly path: string) {}
  private read(): Transaction[] {
    const rows = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as { transactions: Transaction[] }).transactions : [];
    return rows.map(t => ({ ...t, status: LEGACY_STATUS[t.status] ?? t.status }));
  }
  list() { return this.read(); }
  find(paymentRefId: string) { return this.read().find(t => t.payment_ref_id === paymentRefId); }
  save(txn: Transaction) {
    const transactions = this.read().filter(t => t.payment_ref_id !== txn.payment_ref_id);
    const now = new Date().toISOString();
    Object.assign(txn, { created_at: txn.created_at ?? now, updated_at: now });
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ transactions: [...transactions, txn] }, null, 2));
    return txn;
  }
}

// Adyen standard-notification HMAC: https://docs.adyen.com/development-resources/webhooks/verify-hmac-signatures
export type AdyenNotificationItem = {
  pspReference: string; originalReference?: string; merchantAccountCode: string; merchantReference: string;
  amount: { value: number; currency: string }; eventCode: string; success: string; paymentMethod?: string; reason?: string; additionalData?: { hmacSignature?: string };
};
export function validAdyenHmac(item: AdyenNotificationItem, hexKey: string) {
  const payload = [item.pspReference, item.originalReference ?? '', item.merchantAccountCode, item.merchantReference,
    item.amount.value, item.amount.currency, item.eventCode, item.success].join(':');
  const expected = createHmac('sha256', Buffer.from(hexKey, 'hex')).update(payload).digest();
  const given = Buffer.from(item.additionalData?.hmacSignature ?? '', 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
