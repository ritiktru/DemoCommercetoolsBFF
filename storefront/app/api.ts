export type Money = { currencyCode: string; centAmount: number };
export type LineItemData = {
  id: string; name: Record<string, string>; quantity: number; totalPrice: Money;
  price?: { value: Money; discounted?: { value: Money } };
  variant: { sku?: string; images?: Array<{ url: string }> };
};
export type Cart = {
  id: string; version: number; country?: string; totalPrice: Money;
  taxedPrice?: { totalGross: Money; totalTax?: Money };
  shippingInfo?: { shippingMethodName?: string; price?: Money };
  discountOnTotalPrice?: { discountedAmount: Money };
  discountCodes?: Array<{ state: string; discountCode: { id: string; obj?: { code: string } } }>;
  lineItems: LineItemData[];
};
export const money = (value?: Money) => value ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: value.currencyCode }).format(value.centAmount / 100) : 'No price';
export const localName = (name: Record<string, string>) => name['en-GB'] ?? name['en-US'] ?? name['en-CA'] ?? Object.values(name)[0] ?? '';
// Unit price the shopper pays per item before cart-level discounts (product discounts already applied).
export const unitPrice = (item: LineItemData) => item.price?.discounted?.value ?? item.price?.value;
export async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? 'Request failed');
  return body;
}
