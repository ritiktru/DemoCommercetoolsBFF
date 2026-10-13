import { z } from 'zod';

export const createPromotionInput = z.strictObject({
  sku: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(120),
  discountType: z.enum(['percentage', 'fixed']),
  discount: z.number().positive().max(100000),
});

export type CreatePromotionInput = z.infer<typeof createPromotionInput>;

export const createBundlePromotionInput = z.strictObject({
  skus: z.array(z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/)).min(2).max(100)
    .transform(skus => [...new Set(skus)]).refine(skus => skus.length >= 2, 'Provide at least two unique SKUs'),
  name: z.string().trim().min(1).max(120),
  promotionType: z.enum(['fixedBundlePrice', 'percentageOff']),
  quantity: z.number().int().min(2).max(100),
  discount: z.number().positive().max(100000),
  repeat: z.boolean().default(true),
});

export type CreateBundlePromotionInput = z.infer<typeof createBundlePromotionInput>;

export interface PromotionService {
  listPromotions(): Promise<unknown>;
  createPromotion(input: CreatePromotionInput): Promise<unknown>;
  removePromotion(id: string): Promise<unknown>;
  listBundlePromotions(): Promise<unknown>;
  createBundlePromotion(input: CreateBundlePromotionInput): Promise<unknown>;
  removeBundlePromotion(id: string): Promise<unknown>;
}
