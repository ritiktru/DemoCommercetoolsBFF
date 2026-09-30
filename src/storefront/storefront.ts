import { z } from 'zod';
import type { SessionCustomer } from '../sessions.js';

export const storeKeySchema = z.string().trim().min(1).max(256).regex(/^sobeys-[0-9]+$/);
export const addItemInput = z.strictObject({ cartId: z.uuid(), version: z.number().int().positive(), sku: z.string().min(1).max(256), quantity: z.number().int().min(1).max(99) });
export const PERCENT_DISCOUNT_CODE = 'POC10';
export const PERCENT_DISCOUNT = 10;
export const FLAT_DISCOUNT_CODE = 'FLAT25';
export const FLAT_DISCOUNT_CENTS = 2500;
export const FREE_SHIPPING_CODE = 'FREESHIP';
export type AddItemInput = z.infer<typeof addItemInput>;
export const applyDiscountInput = z.strictObject({
  cartId: z.uuid(),
  version: z.number().int().positive(),
  code: z.string().trim().min(1).max(50),
});

export type ApplyDiscountInput = z.infer<typeof applyDiscountInput>;
export const removeDiscountInput = z.strictObject({
  cartId: z.uuid(),
  version: z.number().int().positive(),
  kind: z.enum(['product', 'shipping', 'all']).default('all'),
});
export type RemoveDiscountInput = z.infer<typeof removeDiscountInput>;
export const checkoutAddressInput = z.strictObject({
  cartId: z.uuid(),
  email: z.email().max(254),
  address: z.strictObject({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    streetName: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(2).max(100),
    postalCode: z.string().trim().min(3).max(20),
  }),
});
export type CheckoutAddressInput = z.infer<typeof checkoutAddressInput>;
export interface StorefrontService {
  listStores(): Promise<unknown>;
  listStoreProducts(storeKey: string): Promise<unknown>;
  createStoreCart(storeKey: string, customer?: SessionCustomer): Promise<unknown>;
  addStoreCartItem(storeKey: string, input: AddItemInput, customer?: SessionCustomer): Promise<unknown>;
  applyStoreCartDiscount(storeKey: string, input: ApplyDiscountInput, customer?: SessionCustomer): Promise<unknown>;
  removeStoreCartDiscount(storeKey: string, input: RemoveDiscountInput, customer?: SessionCustomer): Promise<unknown>;
  setCheckoutAddress(storeKey: string, input: CheckoutAddressInput, customer?: SessionCustomer): Promise<unknown>;
  listCheckoutShippingMethods(storeKey: string, cartId: string, customer?: SessionCustomer): Promise<unknown>;
  setCheckoutShippingMethod(storeKey: string, cartId: string, shippingMethodId: string, customer?: SessionCustomer): Promise<unknown>;
  createCheckoutSession(storeKey: string, cartId: string, customer?: SessionCustomer): Promise<unknown>;
}
