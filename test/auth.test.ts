import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { TokenPayload } from 'google-auth-library';
import { createApp } from '../src/app.js';
import { GoogleVerifier, type GoogleIdentity } from '../src/google.js';
import { CommerceError, type CustomerResult } from '../src/commercetools.js';
import type { AuthOptions } from '../src/auth.js';

const identity: GoogleIdentity = { subject: 'google-subject', email: 'person@gmail.com', authoritativeEmail: true };
const customer: CustomerResult = { customer: { id: 'customer-1', version: 1, email: identity.email, authenticationMode: 'ExternalAuth', isEmailVerified: true, createdAt: '2026-09-16T00:00:00Z' } };
const origin = 'http://localhost:3000';
const defaultAuth: AuthOptions = {
  clientId: 'fake.apps.googleusercontent.com', origin,
  verifier: { verify: async (_token, nonce) => { assert.ok(nonce); return identity; } },
  customers: { resolveGoogleCustomer: async () => customer },
};
async function withApp(auth: AuthOptions, run: (base: string) => Promise<void>) {
  const app = await createApp({ createCustomer: async () => customer }, auth);
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await app.close(); }
}
const login = (base: string, cookie: string, requestOrigin = origin) => fetch(`${base}/api/auth/google`, {
  method: 'POST', headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: 'fake-token' }),
});

test('Google login issues HttpOnly session, supports me and revokes on logout', async () => {
  await withApp(defaultAuth, async base => {
    const challenge = await fetch(`${base}/api/auth/google/challenge`);
    assert.ok((await challenge.json()).nonce);
    const challengeCookie = challenge.headers.getSetCookie()[0]!.split(';')[0]!;
    const response = await login(base, challengeCookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).customer.id, customer.customer.id);
    const sessionHeader = response.headers.getSetCookie().find(value => value.startsWith('bff_session='))!;
    assert.ok(sessionHeader.includes('HttpOnly'));
    assert.ok(sessionHeader.includes('SameSite=Strict'));
    assert.ok(sessionHeader.includes('Path=/api'));
    const sessionCookie = sessionHeader.split(';')[0]!;
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: sessionCookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).customer.id, customer.customer.id);
    assert.equal((await login(base, challengeCookie)).status, 401, 'Challenge must be single use');
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Origin: origin, Cookie: sessionCookie } })).status, 204);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: sessionCookie } })).status, 401);
  });
});

test('missing challenge, invalid token and cross-origin requests cannot sign in', async () => {
  let customerCalls = 0;
  await withApp({ ...defaultAuth,
    verifier: { verify: async () => { throw new CommerceError(401, 'InvalidGoogleToken', 'Invalid token'); } },
    customers: { resolveGoogleCustomer: async () => { customerCalls++; return customer; } },
  }, async base => {
    assert.equal((await login(base, '')).status, 401);
    const challenge = await fetch(`${base}/api/auth/google/challenge`);
    const cookie = challenge.headers.getSetCookie()[0]!.split(';')[0]!;
    assert.equal((await login(base, cookie, 'https://attacker.example')).status, 403);
    assert.equal((await login(base, cookie)).status, 401);
    assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
    assert.equal((await fetch(`${base}/api/auth/google/challenge`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });
  assert.equal(customerCalls, 0);
});

test('Google verifier delegates token checks with configured audience and checks nonce and verified email', async () => {
  let payload: object = { sub: 'subject', email: 'person@gmail.com', email_verified: true, nonce: 'challenge' };
  const verifier = new GoogleVerifier('expected-client', {
    verifyIdToken: async options => {
      assert.deepEqual(options, { idToken: 'token', audience: 'expected-client' });
      return { getPayload: () => payload as TokenPayload };
    },
  });
  assert.equal((await verifier.verify('token', 'challenge')).authoritativeEmail, true);
  await assert.rejects(verifier.verify('token', 'wrong-nonce'), { status: 401 });
  payload = { ...payload, email_verified: false };
  await assert.rejects(verifier.verify('token', 'challenge'), { status: 401 });
  payload = { ...payload, email_verified: true, email: 'person@example.com' };
  assert.equal((await verifier.verify('token', 'challenge')).authoritativeEmail, false);
  payload = { ...payload, hd: 'example.com' };
  assert.equal((await verifier.verify('token', 'challenge')).authoritativeEmail, true);
  const broken = new GoogleVerifier('expected-client', { verifyIdToken: async () => { throw new Error('sensitive details'); } });
  await assert.rejects(broken.verify('token', 'challenge'), (error: unknown) => error instanceof CommerceError && error.status === 401 && !error.message.includes('sensitive'));
});
