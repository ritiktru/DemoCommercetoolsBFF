import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';

test('NestJS serves health and login, handles missing routes, large bodies and disabled auth safely', async () => {
  const app = await createApp({ createCustomer: async () => { throw new Error('Must not call commerce'); } });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.ok(health.headers.get('x-request-id'));
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('x-powered-by'), null);
    const page = await fetch(`${base}/login`);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-type')?.includes('text/html'));
    assert.ok((await page.text()).includes('Passwordless login POC'));
    assert.equal((await fetch(`${base}/login.js`)).status, 200);
    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { code: 'NotFound', message: 'Route not found' } });
    const disabled = await fetch(`${base}/api/auth/google/challenge`);
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).error.code, 'LoginNotConfigured');
    const large = await fetch(`${base}/api/customers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a'.repeat(17000) }),
    });
    assert.equal(large.status, 413);
    assert.equal((await large.json()).error.code, 'InvalidBody');
  } finally { await app.close(); }
});
