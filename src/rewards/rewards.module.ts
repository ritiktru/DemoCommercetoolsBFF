import { Body, Controller, Delete, Get, Inject, Module, Param, Post, Req, UseGuards, type DynamicModule } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService, OriginGuard, SessionGuard } from '../auth.js';
import { CommerceError } from '../commercetools.js';
import { rewardRuleInput, type RewardService } from './rewards.js';
import { rewardsPage, rewardsScript } from './rewards-page.js';
import { Header } from '@nestjs/common';
const SERVICE = Symbol('REWARD_SERVICE');

@Controller()
export class RewardsController {
  constructor(@Inject(SERVICE) private readonly rewards: RewardService, @Inject(AuthService) private readonly auth: AuthService) {}
  @Get('rewards') @Header('Content-Type', 'text/html; charset=utf-8') page() { return rewardsPage; }
  @Get('rewards.js') @Header('Content-Type', 'application/javascript; charset=utf-8') script() { return rewardsScript; }
  @Get('api/rewards/rules') list() { return this.rewards.listRules(); }
  @Post('api/rewards/rules') create(@Body() body: unknown) { const input = rewardRuleInput.safeParse(body); if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a key, name, SKUs, quantity, and points'); return this.rewards.saveRule(input.data); }
  @Delete('api/rewards/rules/:key') remove(@Param('key') key: string) { if (!z.string().regex(/^[A-Za-z0-9_-]+$/).safeParse(key).success) throw new CommerceError(400, 'InvalidInput', 'Invalid rule key'); return this.rewards.removeRule(key); }
  @Get('api/rewards/balance') @UseGuards(SessionGuard) balance(@Req() req: Request) { return this.rewards.balance(this.auth.customer(req)); }
  @Post('api/rewards/preview') @UseGuards(OriginGuard, SessionGuard) preview(@Body() body: unknown, @Req() req: Request) { const input = z.strictObject({ cartId: z.uuid() }).safeParse(body); if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid cart ID'); return this.rewards.previewCart(input.data.cartId, this.auth.customer(req)); }
  @Post('api/rewards/reconcile') @UseGuards(OriginGuard, SessionGuard) reconcile(@Req() req: Request) { return this.rewards.reconcileLatestOrder(this.auth.customer(req)); }
  @Post('api/rewards/orders/:orderId/award') @UseGuards(OriginGuard, SessionGuard) award(@Param('orderId') orderId: string, @Req() req: Request) { if (!z.uuid().safeParse(orderId).success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid order ID'); return this.rewards.awardOrder(orderId, this.auth.customer(req)); }
}

@Module({})
export class RewardsModule { static register(service: RewardService, auth: DynamicModule): DynamicModule { return { module: RewardsModule, imports: [auth], controllers: [RewardsController], providers: [{ provide: SERVICE, useValue: service }] }; } }
