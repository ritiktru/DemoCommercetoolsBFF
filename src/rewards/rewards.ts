import { z } from 'zod';
import type { SessionCustomer } from '../sessions.js';

export const rewardRuleInput = z.strictObject({
  key: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(200),
  eligibleSkus: z.array(z.string().trim().min(1).max(256)).min(1).max(100),
  requiredQuantity: z.number().int().min(1).max(999),
  points: z.number().int().min(1).max(1_000_000),
  repeat: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type RewardRuleInput = z.infer<typeof rewardRuleInput>;

export interface RewardService {
  listRules(): Promise<unknown>;
  saveRule(input: RewardRuleInput): Promise<unknown>;
  removeRule(key: string): Promise<unknown>;
  balance(customer: SessionCustomer): Promise<unknown>;
  previewCart(cartId: string, customer: SessionCustomer): Promise<unknown>;
  awardOrder(orderId: string, customer: SessionCustomer): Promise<unknown>;
  reconcileLatestOrder(customer: SessionCustomer): Promise<unknown>;
}
