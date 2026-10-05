import { z } from 'zod';

const host = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash;
}, 'Must be an HTTPS origin without credentials, path, query, or fragment');
const blank = (value: unknown) => value === '' ? undefined : value;
const schema = z.object({
  CT_PROJECT_KEY: z.string().trim().min(1),
  CT_CLIENT_ID: z.string().trim().min(1),
  CT_CLIENT_SECRET: z.string().min(1),
  CT_AUTH_URL: host,
  CT_API_URL: host,
  CT_SCOPES: z.string().trim().min(1),
  CT_CHECKOUT_SESSION_URL: z.url().optional(),
  CT_PROMO_DISCOUNT_KEY: z.string().trim().min(1).optional(),
  CT_CHECKOUT_APPLICATION_KEY: z.string().trim().min(1).optional(),
  GOOGLE_CLIENT_ID: z.preprocess(value => value === '' ? undefined : value, z.string().regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/).optional()),
  APP_ORIGIN: z.url().optional(),
  // Optional SMTP for password-reset emails. Without SMTP_HOST the link is printed in the BFF terminal (non-production only).
  SMTP_HOST: z.preprocess(blank, z.string().trim().min(1).optional()),
  SMTP_PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(587)),
  SMTP_SECURE: z.preprocess(blank, z.enum(['true', 'false']).default('false')),
  SMTP_USER: z.preprocess(blank, z.string().optional()),
  SMTP_PASS: z.preprocess(blank, z.string().optional()),
  MAIL_FROM: z.preprocess(blank, z.string().trim().min(3).optional()),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Adyen Hosted Checkout (TEST). Without ADYEN_HMAC_KEY the webhook answers 503 and payments stay pending.
  ADYEN_API_KEY: z.preprocess(blank, z.string().min(1).optional()),
  ADYEN_MERCHANT_ACCOUNT: z.preprocess(blank, z.string().trim().min(1).optional()),
  ADYEN_HMAC_KEY: z.preprocess(blank, z.string().regex(/^[0-9A-Fa-f]+$/).optional()),
  PAYMENT_STORE_PATH: z.preprocess(blank, z.string().default('data/transactions.json')),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report field names only; validation errors must never expose env values.
    throw new Error(`Invalid environment configuration: ${[...new Set(result.error.issues.map(i => i.path.join('.')))].join(', ')}`);
  }
  const scopes = result.data.CT_SCOPES.split(/\s+/);
  const projectKey = result.data.CT_PROJECT_KEY;
  if (result.data.APP_ORIGIN) {
    const origin = new URL(result.data.APP_ORIGIN);
    if (origin.origin !== result.data.APP_ORIGIN || origin.username || origin.password ||
        (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost'))) {
      throw new Error('APP_ORIGIN must be an HTTPS origin or http://localhost with an optional port');
    }
  }
  if (!scopes.includes(`manage_customers:${projectKey}`) && !scopes.includes(`manage_project:${projectKey}`)) {
    throw new Error('CT_SCOPES must include manage_customers or manage_project for CT_PROJECT_KEY');
  }
  const { SMTP_HOST, MAIL_FROM, SMTP_USER, SMTP_PASS } = result.data;
  if (SMTP_HOST && !MAIL_FROM) throw new Error('MAIL_FROM is required when SMTP_HOST is set');
  if (Boolean(SMTP_USER) !== Boolean(SMTP_PASS)) throw new Error('Set both SMTP_USER and SMTP_PASS, or neither');
  return result.data;
}
