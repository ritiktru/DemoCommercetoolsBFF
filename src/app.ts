import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { CustomerService } from './commercetools.js';
import type { AuthOptions } from './auth.js';
import { AppModule } from './app.module.js';
import type { CartService } from './carts/cart.js';
import type { StorefrontService } from './storefront/storefront.js';

export async function createApp(customers: CustomerService, auth?: AuthOptions, carts?: CartService, storefront?: StorefrontService): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(customers, auth, carts, storefront), {
    bodyParser: false, logger: false, abortOnError: false,
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Request-Id', randomUUID());
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Keep the exact request bytes: the Global Payments webhook signature is computed over them, not over re-serialized JSON.
  app.use(express.json({ limit: '16kb', verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; } }));
  return app;
}
