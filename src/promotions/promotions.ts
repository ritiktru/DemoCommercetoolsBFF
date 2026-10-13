import { z } from 'zod';

export const createPromotionInput = z.strictObject({
  sku: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(120),
  discountType: z.enum(['percentage', 'fixed']),
  discount: z.number().positive().max(100000),
});

export type CreatePromotionInput = z.infer<typeof createPromotionInput>;

export interface PromotionService {
  listPromotions(): Promise<unknown>;
  createPromotion(input: CreatePromotionInput): Promise<unknown>;
  removePromotion(id: string): Promise<unknown>;
}
