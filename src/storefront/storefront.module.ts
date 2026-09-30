import { Body, Controller, Get, Inject, Module, Param, Post, Req, UseGuards, type DynamicModule } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService, OriginGuard } from '../auth.js';
import { CommerceError } from '../commercetools.js';
import { applyDiscountInput, removeDiscountInput, addItemInput,updateItemInput, checkoutAddressInput, storeKeySchema, type StorefrontService } from './storefront.js';

const SERVICE = Symbol('STOREFRONT_SERVICE');

@Controller('api/storefront')
export class StorefrontController {
  constructor(
    @Inject(SERVICE) private readonly storefront: StorefrontService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get('stores')
  stores() {
    return this.storefront.listStores();
  }

  @Get('stores/:storeKey/products')
  products(@Param('storeKey') raw: string) {
    const key = storeKeySchema.safeParse(raw);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    return this.storefront.listStoreProducts(key.data);
  }

  @Post('stores/:storeKey/carts')
  @UseGuards(OriginGuard)
  createCart(@Param('storeKey') raw: string, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    return this.storefront.createStoreCart(key.data, this.optionalCustomer(req));
  }

  @Post('stores/:storeKey/cart-items')
  @UseGuards(OriginGuard)
  addItem(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    const input = addItemInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId, version, sku, and quantity');
    return this.storefront.addStoreCartItem(key.data, input.data, this.optionalCustomer(req));
  }

  @Post('stores/:storeKey/checkout-session')
  @UseGuards(OriginGuard)
  checkoutSession(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    const input = z.object({ cartId: z.uuid() }).safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid cartId');
    return this.storefront.createCheckoutSession(key.data, input.data.cartId, this.optionalCustomer(req));
  }

  @Post('stores/:storeKey/cart-items/update')
  @UseGuards(OriginGuard)
  updateItem(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    const input = updateItemInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId, version, lineItemId, and quantity');
    return this.storefront.updateStoreCartItem(key.data, input.data, this.optionalCustomer(req));
  }

  @Post('stores/:storeKey/checkout-address')
  @UseGuards(OriginGuard)
  checkoutAddress(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    const input = checkoutAddressInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide email and a Canadian name, street, city, province, and postal code');
    return this.storefront.setCheckoutAddress(key.data, input.data, this.optionalCustomer(req));
  }

  @Get('stores/:storeKey/carts/:cartId/shipping-methods')
  shippingMethods(@Param('storeKey') raw: string, @Param('cartId') cartId: string, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!z.uuid().safeParse(cartId).success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid cart ID');
    return this.storefront.listCheckoutShippingMethods(key.data, cartId, this.optionalCustomer(req));
  }

  @Post('stores/:storeKey/checkout-shipping')
  @UseGuards(OriginGuard)
  checkoutShipping(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    const input = z.strictObject({ cartId: z.uuid(), shippingMethodId: z.uuid() }).safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId and shippingMethodId');
    return this.storefront.setCheckoutShippingMethod(key.data, input.data.cartId, input.data.shippingMethodId, this.optionalCustomer(req));
  }

  @Post('stores/:storeKey/discount')
  @UseGuards(OriginGuard)
  applyDiscount(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    const input = applyDiscountInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId, version, and code');
    return this.storefront.applyStoreCartDiscount(key.data, input.data, this.optionalCustomer(req));
  }

  @Post('stores/:storeKey/discount/remove')
  @UseGuards(OriginGuard)
  removeDiscount(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    const input = removeDiscountInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId and version');
    return this.storefront.removeStoreCartDiscount(key.data, input.data, this.optionalCustomer(req));
  }

  private optionalCustomer(req: Request) {
    try {
      return this.auth.customer(req);
    } catch (error) {
      if (error instanceof CommerceError && error.status === 401) return undefined;
      throw error;
    }
  }
}

@Module({})
export class StorefrontModule {
  static register(service: StorefrontService, auth: DynamicModule): DynamicModule {
    return {
      module: StorefrontModule,
      imports: [auth],
      controllers: [StorefrontController],
      providers: [{ provide: SERVICE, useValue: service }],
    };
  }
}