import { Controller, Get, Inject, Module, Param, Post, Req, UseGuards, type DynamicModule } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService, OriginGuard, SessionGuard } from '../auth.js';
import { CommerceError } from '../commercetools.js';
import { cartInput, type CartService } from './cart.js';

const CART_SERVICE = Symbol('CART_SERVICE');

@Controller('api/carts')
@UseGuards(SessionGuard)
export class CartsController {
  constructor(
    @Inject(CART_SERVICE) private readonly carts: CartService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Post()
  @UseGuards(OriginGuard)
  create(@Req() req: Request) {
    if (!req.is('application/json')) throw new CommerceError(415, 'UnsupportedMediaType', 'Use application/json');
    const input = cartInput.safeParse(req.body);
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide currency (three uppercase letters) and optional country (two uppercase letters). Other fields are not accepted.');
    return this.carts.createCart(input.data, this.auth.customer(req));
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Request) {
    if (!z.uuid().safeParse(id).success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid cart ID');
    return this.carts.getCart(id, this.auth.customer(req));
  }
}

@Module({})
export class CartsModule {
  static register(carts: CartService, authentication: DynamicModule): DynamicModule {
    return {
      module: CartsModule,
      imports: [authentication],
      controllers: [CartsController],
      providers: [{ provide: CART_SERVICE, useValue: carts }],
    };
  }
}
