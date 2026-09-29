import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AuthModule, type AuthOptions } from './auth.js';
import { CustomersModule } from './customers/customers.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import type { CustomerService } from './commercetools.js';
import { CartsModule } from './carts/carts.module.js';
import type { CartService } from './carts/cart.js';
import { StorefrontModule } from './storefront/storefront.module.js';
import type { StorefrontService } from './storefront/storefront.js';

@Module({})
export class AppModule {
  static register(customers: CustomerService, auth?: AuthOptions, carts?: CartService, storefront?: StorefrontService): DynamicModule {
    const authentication = AuthModule.register(auth);
    return {
      module: AppModule,
      imports: [CustomersModule.register(customers), authentication, ...(carts ? [CartsModule.register(carts, authentication)] : []), ...(storefront ? [StorefrontModule.register(storefront, authentication)] : [])],
      controllers: [AppController],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
