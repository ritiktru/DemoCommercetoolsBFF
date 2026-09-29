import { z } from 'zod';
import type { SessionCustomer } from '../sessions.js';

export const cartInput = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
});
export type CartInput = z.infer<typeof cartInput>;
const money = z.object({ currencyCode: z.string(), centAmount: z.number().int(), fractionDigits: z.number().int() });
export const cartSchema = z.object({
  id: z.string().min(1), version: z.number().int().positive(),
  customerId: z.string().optional(), customerEmail: z.string().optional(),
  cartState: z.string(), country: z.string().optional(),
  totalPrice: money,
  lineItems: z.array(z.object({
    id: z.string(), productId: z.string(), quantity: z.number().int(),
    name: z.record(z.string(), z.string()),
    variant: z.object({ id: z.number().int(), sku: z.string().optional() }),
    totalPrice: money,
  })),
  createdAt: z.string(), lastModifiedAt: z.string(),
});
export type CartResult = { cart: z.infer<typeof cartSchema> };
export interface CartService {
  createCart(input: CartInput, customer: SessionCustomer): Promise<CartResult>;
  getCart(id: string, customer: SessionCustomer): Promise<CartResult>;
}
