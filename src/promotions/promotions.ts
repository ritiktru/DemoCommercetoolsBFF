import { z } from 'zod';

export const createPromotionInput = z.strictObject({
  sku: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(120),
  discountType: z.enum(['percentage', 'fixed', 'finalPrice', 'bogo']),
  discount: z.number().positive().max(100000).optional(),
  buyQuantity: z.number().int().min(1).max(100).optional(),
  freeQuantity: z.number().int().min(1).max(100).optional(),
  repeat: z.boolean().optional(),
  customerGroupId: z.uuid().optional(),
}).superRefine((input, context) => {
  if (input.discountType === 'bogo') {
    if (!input.buyQuantity) context.addIssue({ code: 'custom', path: ['buyQuantity'], message: 'Buy quantity is required' });
    if (!input.freeQuantity) context.addIssue({ code: 'custom', path: ['freeQuantity'], message: 'Free quantity is required' });
  } else if (!input.discount) {
    context.addIssue({ code: 'custom', path: ['discount'], message: 'Discount is required' });
  }
});

export type CreatePromotionInput = z.infer<typeof createPromotionInput>;

export const createCustomerGroupPromotionInput = z.strictObject({
  customerGroupId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  discountType: z.enum(['percentage', 'fixed']),
  discount: z.number().positive().max(100000),
});
export type CreateCustomerGroupPromotionInput = z.infer<typeof createCustomerGroupPromotionInput>;

export const createBundlePromotionInput = z.strictObject({
  skus: z.array(z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/)).min(1).max(100)
    .transform(skus => [...new Set(skus)]),
  name: z.string().trim().min(1).max(120),
  promotionType: z.enum(['fixedBundlePrice', 'percentageOff', 'amountOff']),
  quantity: z.number().int().min(2).max(100),
  discount: z.number().positive().max(100000),
  repeat: z.boolean().default(true),
  customerGroupId: z.uuid().optional(),
});

export type CreateBundlePromotionInput = z.infer<typeof createBundlePromotionInput>;

export interface PromotionService {
  listPromotions(): Promise<unknown>;
  createPromotion(input: CreatePromotionInput): Promise<unknown>;
  removePromotion(id: string, resourceType?: 'product-discount' | 'cart-discount'): Promise<unknown>;
  listCustomerGroups(): Promise<unknown>;
  listCustomerGroupPromotions(): Promise<unknown>;
  createCustomerGroupPromotion(input: CreateCustomerGroupPromotionInput): Promise<unknown>;
  listBundlePromotions(): Promise<unknown>;
  createBundlePromotion(input: CreateBundlePromotionInput): Promise<unknown>;
  removeBundlePromotion(id: string): Promise<unknown>;
}
