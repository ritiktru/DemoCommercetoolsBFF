import { Body, Controller, Get, HttpCode, Patch, Inject, Module, Param, Post, Query, Req, UseGuards, type DynamicModule } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService, OriginGuard } from '../auth.js';
import { CommerceError } from '../commercetools.js';
import { productKeySchema, addItemInput, checkoutAddressInput, discountCodeInput, removeDiscountInput, updateItemInput, storeKeySchema, type StorefrontService } from './storefront.js';
const SERVICE = Symbol('STOREFRONT_SERVICE');

@Controller('api/storefront')
export class StorefrontController {
  constructor(@Inject(SERVICE) private readonly storefront: StorefrontService, @Inject(AuthService) private readonly auth: AuthService) {}
  @Get('promotion') promotion() { return this.storefront.getPromotion(); }
  @Get('stores') stores() { return this.storefront.listStores(); }
  @Get('stores/:storeKey/products') products(@Param('storeKey') raw: string) {
    const key = storeKeySchema.safeParse(raw); if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    return this.storefront.listStoreProducts(key.data);
  }
  @Get('stores/:storeKey/products/:productKey') product(@Param('storeKey') raw: string, @Param('productKey') productRaw: string) {
    const key = storeKeySchema.safeParse(raw); if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    const product = productKeySchema.safeParse(productRaw); if (!product.success) throw new CommerceError(404, 'ProductNotFound', 'Product not found');
    return this.storefront.getStoreProduct(key.data, product.data);
  }
  @Post('stores/:storeKey/carts') @UseGuards(OriginGuard)
  createCart(@Param('storeKey') raw: string, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    return this.storefront.createStoreCart(key.data, this.optionalCustomer(req));
  }
  @Post('stores/:storeKey/cart-items') @UseGuards(OriginGuard)
  addItem(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); const input = addItemInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId, version, sku, and quantity');
    return this.storefront.addStoreCartItem(key.data, input.data, this.optionalCustomer(req));
  }
  @Get('stores/:storeKey/carts/:cartId')
  getCart(@Param('storeKey') raw: string, @Param('cartId') cartId: string, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!z.uuid().safeParse(cartId).success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid cart ID');
    return this.storefront.getStoreCart(key.data, cartId, this.optionalCustomer(req));
  }
  @Patch('stores/:storeKey/cart-items') @UseGuards(OriginGuard)
  updateItem(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); const input = updateItemInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId, version, lineItemId, and quantity (0 removes)');
    return this.storefront.updateStoreCartItem(key.data, input.data, this.optionalCustomer(req));
  }
  @Post('stores/:storeKey/discount-codes') @UseGuards(OriginGuard)
  addDiscount(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); const input = discountCodeInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId, version, and code');
    return this.storefront.addDiscountCode(key.data, input.data, this.optionalCustomer(req));
  }
  @Post('stores/:storeKey/discount-codes/remove') @UseGuards(OriginGuard)
  removeDiscount(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); const input = removeDiscountInput.safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId, version, and discountCodeId');
    return this.storefront.removeDiscountCode(key.data, input.data, this.optionalCustomer(req));
  }
  @Post('stores/:storeKey/checkout-session') @UseGuards(OriginGuard)
  checkoutSession(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); const input = z.object({ cartId: z.uuid() }).safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid cartId');
    return this.storefront.createCheckoutSession(key.data, input.data.cartId, this.optionalCustomer(req));
  }
  @Post('stores/:storeKey/checkout/initiate') @UseGuards(OriginGuard)
  initiateCheckout(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); const input = z.strictObject({ cartId: z.uuid() }).safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid cartId');
    return this.storefront.initiateCheckout(key.data, input.data.cartId, this.optionalCustomer(req));
  }
  @Get('stores/:storeKey/order/payment/status')
  paymentStatus(@Param('storeKey') raw: string, @Query('paymentRef') ref: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); const paymentRef = z.string().regex(/^PAY-[0-9a-f-]{36}$/).safeParse(ref);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!paymentRef.success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid paymentRef');
    return this.storefront.paymentStatus(key.data, paymentRef.data, this.optionalCustomer(req));
  }
  @Post('stores/:storeKey/checkout-address') @UseGuards(OriginGuard)
  checkoutAddress(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw); const input = checkoutAddressInput.safeParse(body);
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
  @Post('stores/:storeKey/checkout-shipping') @UseGuards(OriginGuard)
  checkoutShipping(@Param('storeKey') raw: string, @Body() body: unknown, @Req() req: Request) {
    const key = storeKeySchema.safeParse(raw);
    const input = z.strictObject({ cartId: z.uuid(), shippingMethodId: z.uuid() }).safeParse(body);
    if (!key.success) throw new CommerceError(404, 'StoreNotFound', 'Store not found');
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide cartId and shippingMethodId');
    return this.storefront.setCheckoutShippingMethod(key.data, input.data.cartId, input.data.shippingMethodId, this.optionalCustomer(req));
  }
  private optionalCustomer(req: Request) { try { return this.auth.customer(req); } catch (error) { if (error instanceof CommerceError && error.status === 401) return undefined; throw error; } }
}
// Server-to-server from Adyen: authenticated by HMAC signature, not by origin or session.
@Controller('api/orders')
export class PaymentWebhookController {
  constructor(@Inject(SERVICE) private readonly storefront: StorefrontService) {}
  @Post('webhook') @HttpCode(200) webhook(@Body() body: unknown) { return this.storefront.handlePaymentWebhook(body); }
}
@Module({})
export class StorefrontModule {
  static register(service: StorefrontService, auth: DynamicModule): DynamicModule {
    return { module: StorefrontModule, imports: [auth], controllers: [StorefrontController, PaymentWebhookController], providers: [{ provide: SERVICE, useValue: service }] };
  }
}
