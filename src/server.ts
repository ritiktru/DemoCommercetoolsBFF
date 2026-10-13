import 'reflect-metadata';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { CommercetoolsClient } from './commercetools.js';
import { createApp } from './app.js';
import { GoogleVerifier } from './google.js';
import { CommercetoolsPromotionClient } from './promotions/promotions-client.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const customers = new CommercetoolsClient(config);
  const auth = config.GOOGLE_CLIENT_ID ? {
    clientId: config.GOOGLE_CLIENT_ID,
    origin: config.APP_ORIGIN ?? `http://localhost:${config.PORT}`,
    verifier: new GoogleVerifier(config.GOOGLE_CLIENT_ID), customers,
  } : undefined;
  const promotions = new CommercetoolsPromotionClient(config);
  const app = await createApp(customers, auth, customers, customers, promotions);
  app.enableShutdownHooks();
  try { await app.listen(config.PORT, '127.0.0.1'); }
  catch { await app.close(); throw new Error('Unable to start BFF server'); }
  console.log(`NestJS BFF listening at http://127.0.0.1:${config.PORT}`);
  console.log(`Login test page: http://localhost:${config.PORT}/login`);
  console.log(`Promotion dashboard: http://localhost:${config.PORT}/promotions`);
}
bootstrap().catch(error => {
  console.error(error instanceof Error ? error.message : 'Unable to start BFF');
  process.exitCode = 1;
});
