import { z } from 'zod';
import type { SessionCustomer } from '../sessions.js';

// Stores come from commercetools; this only guards the URL segment before it reaches the API.
export const productKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const storeKeySchema = z.string().regex(/^[A-Za-z0-9_-]{2,256}$/);
export const addItemInput = z.strictObject({ cartId: z.uuid(), version: z.number().int().positive(), sku: z.string().min(1).max(256), quantity: z.number().int().min(1).max(99) });
export type AddItemInput = z.infer<typeof addItemInput>;
export const updateItemInput = z.strictObject({ cartId: z.uuid(), version: z.number().int().positive(), lineItemId: z.uuid(), quantity: z.number().int().min(0).max(99) });
export type UpdateItemInput = z.infer<typeof updateItemInput>;
export const discountCodeInput = z.strictObject({ cartId: z.uuid(), version: z.number().int().positive(), code: z.string().trim().min(1).max(64) });
export type DiscountCodeInput = z.infer<typeof discountCodeInput>;
export const removeDiscountInput = z.strictObject({ cartId: z.uuid(), version: z.number().int().positive(), discountCodeId: z.uuid() });
const addressInput = z.strictObject({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  streetName: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().min(3).max(20),
  phone: z.string().trim().min(5).max(30).optional(),
});
// billingAddress defaults to the shipping address.
export const checkoutAddressInput = z.strictObject({ cartId: z.uuid(), email: z.email().max(254), address: addressInput, billingAddress: addressInput.optional() });
export type CheckoutAddressInput = z.infer<typeof checkoutAddressInput>;
export interface StorefrontService {
  listStores(): Promise<unknown>;
  getPromotion(): Promise<unknown>;
  listStoreProducts(storeKey: string): Promise<unknown>;
  getStoreProduct(storeKey: string, productKey: string): Promise<unknown>;
  createStoreCart(storeKey: string, customer?: SessionCustomer): Promise<unknown>;
  getStoreCart(storeKey: string, cartId: string, customer?: SessionCustomer): Promise<unknown>;
  updateStoreCartItem(storeKey: string, input: UpdateItemInput, customer?: SessionCustomer): Promise<unknown>;
  addDiscountCode(storeKey: string, input: DiscountCodeInput, customer?: SessionCustomer): Promise<unknown>;
  removeDiscountCode(storeKey: string, input: z.infer<typeof removeDiscountInput>, customer?: SessionCustomer): Promise<unknown>;
  addStoreCartItem(storeKey: string, input: AddItemInput, customer?: SessionCustomer): Promise<unknown>;
  setCheckoutAddress(storeKey: string, input: CheckoutAddressInput, customer?: SessionCustomer): Promise<unknown>;
  listCheckoutShippingMethods(storeKey: string, cartId: string, customer?: SessionCustomer): Promise<unknown>;
  setCheckoutShippingMethod(storeKey: string, cartId: string, shippingMethodId: string, customer?: SessionCustomer): Promise<unknown>;
  initiateCheckout(storeKey: string, cartId: string, customer?: SessionCustomer): Promise<unknown>;
  paymentStatus(storeKey: string, paymentRefId: string, customer?: SessionCustomer): Promise<unknown>;
  handlePaymentWebhook(body: unknown): unknown;
  createCheckoutSession(storeKey: string, cartId: string, customer?: SessionCustomer): Promise<unknown>;
}
