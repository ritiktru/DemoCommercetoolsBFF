import { z } from 'zod';
import type { SessionCustomer } from '../sessions.js';

export const storeKeySchema = z.string().trim().min(1).max(256).regex(/^sobeys-[0-9]+$/);
export const addItemInput = z.strictObject({ cartId: z.uuid(), version: z.number().int().positive(), sku: z.string().min(1).max(256), quantity: z.number().int().min(1).max(99) });
export type AddItemInput = z.infer<typeof addItemInput>;
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
export const billingAddressInput = z.strictObject({
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
export type BillingAddressInput = z.infer<typeof billingAddressInput>;
export interface StorefrontService {
  listStores(): Promise<unknown>;
  listStoreProducts(storeKey: string): Promise<unknown>;
  createStoreCart(storeKey: string, customer?: SessionCustomer): Promise<unknown>;
  addStoreCartItem(storeKey: string, input: AddItemInput, customer?: SessionCustomer): Promise<unknown>;
  setCheckoutAddress(storeKey: string, input: CheckoutAddressInput, customer?: SessionCustomer): Promise<unknown>;
  listCheckoutShippingMethods(storeKey: string, cartId: string, customer?: SessionCustomer): Promise<unknown>;
  setCheckoutShippingMethod(storeKey: string, cartId: string, shippingMethodId: string, customer?: SessionCustomer): Promise<unknown>;
  createCheckoutSession(storeKey: string, cartId: string, customer?: SessionCustomer): Promise<unknown>;
  getDeliveryPass?(): Promise<unknown>;
  createDeliveryPassCart?(customer: SessionCustomer): Promise<unknown>;
  setDeliveryPassAddress?(input: CheckoutAddressInput, customer: SessionCustomer): Promise<unknown>;
  createDeliveryPassCheckoutSession?(cartId: string, customer: SessionCustomer): Promise<unknown>;
  activateDeliveryPass?(orderId: string, customer: SessionCustomer): Promise<unknown>;
}
