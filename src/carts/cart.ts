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
  shippingInfo: z.object({
    shippingMethodName: z.string().optional(),
    price: money.optional(),
    shippingRate: z.object({
      price: money,
      freeAbove: money.optional(),
    }).optional(),
    discountedPrice: z.object({
      value: money,
      includedDiscounts: z.array(z.object({
        discount: z.object({ id: z.string(), typeId: z.string().optional() }),
        discountedAmount: money,
      })).default([]),
    }).optional(),
    taxedPrice: z.object({ totalNet: money, totalGross: money }).optional(),
  }).optional(),
  taxedPrice: z.object({
    totalNet: money,
    totalGross: money,
    taxPortions: z.array(z.object({ rate: z.number(), amount: money })),
  }).optional(),
  lineItems: z.array(z.object({
    id: z.string(), productId: z.string(), quantity: z.number().int(),
    name: z.record(z.string(), z.string()),
    variant: z.object({ id: z.number().int(), sku: z.string().optional() }),
    price: z.object({
      value: money,
      discounted: z.object({
        value: money,
        discount: z.object({ id: z.string(), typeId: z.string().optional() }).optional(),
      }).optional(),
    }).optional(),
    discountedPricePerQuantity: z.array(z.object({
      quantity: z.number().int().positive(),
      discountedPrice: z.object({
        value: money,
        includedDiscounts: z.array(z.object({
          discount: z.object({ id: z.string(), typeId: z.string().optional() }),
          discountedAmount: money,
        })).default([]),
      }),
    })).default([]),
    taxedPrice: z.object({ totalNet: money, totalGross: money }).optional(),
    totalPrice: money,
  })),
  createdAt: z.string(), lastModifiedAt: z.string(),
});
export type CartResult = { cart: z.infer<typeof cartSchema> };
export interface CartService {
  createCart(input: CartInput, customer: SessionCustomer): Promise<CartResult>;
  getCart(id: string, customer: SessionCustomer): Promise<CartResult>;
}
