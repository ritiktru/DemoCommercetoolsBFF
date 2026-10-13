import { Body, Controller, Delete, Get, Header, Inject, Module, Param, Post, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';
import { CommerceError } from '../commercetools.js';
import { createPromotionInput, type PromotionService } from './promotions.js';
import { promotionsPage, promotionsScript } from './promotions-page.js';

const SERVICE = Symbol('PROMOTION_SERVICE');

@Controller()
export class PromotionsController {
  constructor(@Inject(SERVICE) private readonly promotions: PromotionService) {}

  @Get('promotions')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page() { return promotionsPage; }

  @Get('promotions.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  script() { return promotionsScript; }

  @Get('api/promotions')
  list() { return this.promotions.listPromotions(); }

  @Post('api/promotions')
  create(@Body() body: unknown) {
    const input = createPromotionInput.safeParse(body);
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid SKU, name, discount type, and positive discount value');
    return this.promotions.createPromotion(input.data);
  }

  @Delete('api/promotions/:id')
  remove(@Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid product discount ID');
    return this.promotions.removePromotion(id);
  }
}

@Module({})
export class PromotionsModule {
  static register(service: PromotionService): DynamicModule {
    return { module: PromotionsModule, controllers: [PromotionsController], providers: [{ provide: SERVICE, useValue: service }] };
  }
}
