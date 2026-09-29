import { Controller, Inject, Module, Post, Req, type DynamicModule } from '@nestjs/common';
import type { Request } from 'express';
import { CommerceError, customerInput, type CustomerService } from '../commercetools.js';

export const CUSTOMER_SERVICE = Symbol('CUSTOMER_SERVICE');

@Controller('api/customers')
export class CustomersController {
  constructor(@Inject(CUSTOMER_SERVICE) private readonly customers: CustomerService) {}

  @Post()
  async create(@Req() req: Request) {
    if (!req.is('application/json')) throw new CommerceError(415, 'UnsupportedMediaType', 'Use application/json');
    const input = customerInput.safeParse(req.body);
    if (!input.success) {
      throw new CommerceError(400, 'InvalidInput', 'Provide a valid email and optional firstName and lastName. Other fields are not accepted.');
    }
    return this.customers.createCustomer(input.data);
  }
}

@Module({})
export class CustomersModule {
  static register(customers: CustomerService): DynamicModule {
    return {
      module: CustomersModule,
      controllers: [CustomersController],
      providers: [{ provide: CUSTOMER_SERVICE, useValue: customers }],
      exports: [CUSTOMER_SERVICE],
    };
  }
}
