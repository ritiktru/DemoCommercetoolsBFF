# commercetools BFF POC

NestJS + Node.js + TypeScript backend for Next.js and React Native. This POC creates commercetools customers without passwords using `authenticationMode: ExternalAuth` and supports passwordless Google sign-in with BFF sessions and customer cart creation.

## Run locally

Requires Node.js 22 or newer.

1. In your trial project's Merchant Center, create an API Client with `manage_customers:<project-key>` and `manage_orders:<project-key>` scopes.
2. Copy `.env.example` to `.env`. Fill in `CT_PROJECT_KEY`, `CT_CLIENT_ID`, `CT_CLIENT_SECRET`, and `CT_SCOPES`. Use the API and auth hosts for your project's region from Merchant Center; the sample hosts are for Europe on Google Cloud.
3. Run:

```sh
npm install
npm run dev
```

`.env` is ignored by Git. Credentials and OAuth tokens stay in the BFF and are never returned to clients. Supply environment variables directly when running in a hosted environment. No credentials are needed for the mocked tests.

The server binds to `127.0.0.1` for local development. Use `localhost` in the browser for Google login. `GET /health` reports process health, not commercetools connectivity. Startup validates configuration; credentials are checked on the first customer request.

## Create a customer

```sh
curl -i http://127.0.0.1:3000/api/customers \
  -H 'Content-Type: application/json' \
  -d '{"email":"poc.customer@example.com","firstName":"POC","lastName":"Customer"}'
```

Successful requests return HTTP 201:

```json
{
  "customer": {
    "id": "<commercetools-generated-id>",
    "version": 1,
    "email": "poc.customer@example.com",
    "firstName": "POC",
    "lastName": "Customer",
    "authenticationMode": "ExternalAuth",
    "isEmailVerified": false,
    "createdAt": "<timestamp>"
  }
}
```

The BFF always sends `ExternalAuth` and never sends a password. Accepted input is only `email` and optional `firstName` and `lastName`; unknown fields are rejected. Email verification is not asserted by this endpoint. Responses use an allowlist of customer fields.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input or malformed JSON |
| 409 | Customer email already exists |
| 413 | JSON body exceeds 16kb |
| 415 | Content type is not application/json |
| 502 | Commerce authentication, API, network, or response failure |
| 503 | commercetools rate limit |

Errors have the shape `{"error":{"code":"InvalidInput","message":"..."}}`. Upstream bodies and credentials are not exposed. OAuth tokens are cached in memory with an expiry buffer; concurrent token requests share one request. Upstream requests have a 10-second timeout. Customer creation is not automatically retried to avoid ambiguous duplicate writes.

For Next.js, forward `/api/customers` through a server route or development proxy to this BFF. There is no browser CORS configuration in this increment.

## Validation

```sh
npm run typecheck
npm test
npm run build
npm start
```

Tests mock the commercetools transport and exercise the HTTP endpoint, outgoing ExternalAuth draft, token caching, validation, and sanitized errors. They do not create trial customers.

## Passwordless Google login

In Google Auth Platform, create a Web application OAuth client. Add `http://localhost` and `http://localhost:3000` to Authorized JavaScript origins. If the app audience is in Testing, add your account as a test user as needed. This ID-token flow needs only the client ID, not a Google client secret.

Add to `.env`:

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
APP_ORIGIN=http://localhost:3000
```

`APP_ORIGIN` defaults to `http://localhost:<PORT>` if omitted. It must match the browser origin and Google's authorized origin exactly. Restart after changing `.env`.

1. Run `npm run dev` and open **http://localhost:3000/login** in your browser. Use `localhost`, not `127.0.0.1`, for sign-in.
2. Click **Sign in with Google** and select a Gmail or Google Workspace account. Google may ask you to authenticate your Google account; the BFF never receives or stores that password.
3. The page displays the commerce customer ID and BFF session expiry. A new customer will be visible in Merchant Center.
4. Click **Check session** to verify authenticated access.
5. Click **Log out**, then **Check session**: it should report that you need to sign in.
6. Click **Reload sign-in** and sign in again: the same Google subject should resolve to the same commerce customer ID.

The example `poc.test.001@example.com` customer cannot sign in with Google. Test with your actual Gmail or Google Workspace identity.

| Endpoint | Purpose |
| --- | --- |
| `GET /login` | Local Google sign-in test page |
| `GET /api/auth/google/challenge` | Returns public client ID and nonce; sets HttpOnly challenge cookie |
| `POST /api/auth/google` | Accepts `{ "idToken": "<Google credential>" }` and creates a session |
| `GET /api/auth/me` | Returns the session's customer ID and email; 401 without a valid session |
| `POST /api/auth/logout` | Revokes the session and clears its cookie |

Google login must include the challenge cookie, and the token must contain the returned nonce. Login and logout requests must have `Origin: <APP_ORIGIN>`. The test page handles all of this. Simply submitting an email or customer ID cannot sign a user in.

The official Google auth library verifies the ID token's signature, issuer, audience, and expiry. The BFF additionally requires verified email and a matching one-time nonce. The stored unique customer key is `google-<SHA256 of Google subject>`. This reserves the customer key for identity mapping in this POC. Repeat logins resolve by this key; changes to Google email do not automatically update the commerce email.

On first login, the BFF can link an existing unbound `ExternalAuth` customer by a Google-authoritative email, or create a new customer. Password customers and customers with other keys require a separate account-linking flow. New Google customers have `isEmailVerified: true`; existing customer verification flags remain unchanged, since commercetools email verification is a separate lifecycle. Unbound Google accounts using third-party email addresses are rejected until an additional email verification flow exists.

Session cookies are HttpOnly, SameSite Strict, scoped to `/api`, and Secure when `APP_ORIGIN` uses HTTPS. Sessions expire after one hour; challenges expire after five minutes and are single use. Both stores are in memory and bounded to 1000 entries: restarting loses sessions, and this POC supports one BFF process. The browser sees no raw session token in JSON or Google client secret. A future React Native client will need a native sign-in and session transport integration; the test flow implemented here uses browser cookies.

Common issues:

- **Origin not allowed by Google:** ensure the browser is on `http://localhost:3000` and that origin is authorized for this client ID. Google configuration changes may take time to propagate.
- **Sign-in cannot be verified:** use **Reload sign-in**, then retry. Check that `GOOGLE_CLIENT_ID` is the Web client used by this page.
- **Invalid origin:** check `APP_ORIGIN`, browser host, and port.
- **403 EmailVerificationRequired:** use a Gmail or Google Workspace account for this POC.
- **409 AccountLinkRequired:** the existing customer has a password or a different key; use another account for the POC or implement explicit account linking.

Tests mock Google token verification and commercetools responses. Live Google sign-in requires the browser flow above; no live users are created by the test suite.

## Create a customer cart (POC point 3)

Restart the BFF, open **http://localhost:3000/login**, and sign in. In **Create a customer cart**, enter the currency matching your product prices (for example `EUR` or `CAD`) and optionally a two-letter country such as `DE` or `CA`. Click **Create cart**.

A successful request returns HTTP 201 with `{ "cart": { ... } }`, including the commercetools cart ID, version, customer ID, an empty `lineItems` array, and a zero total. The customer ID must match your logged-in customer. Click **Fetch created cart** to retrieve the persisted cart from commercetools. Each creation request makes a new empty cart; existing carts are not reused or automatically retried.

Endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/carts` | Creates a cart belonging to the logged-in customer |
| `GET /api/carts/:id` | Retrieves a cart only if it belongs to the logged-in customer |

Accepted creation body:

```json
{ "currency": "EUR", "country": "DE" }
```

`currency` is required and uses three uppercase letters. `country` is optional and uses two uppercase letters. commercetools validates these codes. The BFF sets `customerId` and `customerEmail` from the session; caller-supplied ownership, guest IDs, prices, and items are rejected. Cart reads require a UUID. The API returns only selected cart fields.

Requests use the same HttpOnly BFF session cookie as Google login. Browser requests to `POST /api/carts` also require the configured origin, checked by `OriginGuard`. A missing, expired, or logged-out session returns 401; cross-origin writes return 403. Other customers' carts and anonymous carts return 404.

To call from the browser console after signing in on the login page:

```js
const response = await fetch('/api/carts', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ currency: 'EUR' })
});
console.log(response.status, await response.json());
```

Use `manage_orders:<project-key>` together with `manage_customers:<project-key>` in the API Client and `CT_SCOPES`, separated by a space. An existing `manage_project:<project-key>` scope already covers cart operations for this POC; no scope change is needed for that client. Without a cart management scope, creation returns 503 `CartScopeMissing`. Upstream 400 errors become safe `InvalidCart` responses, rate limits return 503, and other service failures return sanitized errors. No commercetools credentials or tokens are exposed.

Products are added in the next increment. Guest carts and guest checkout are later requirements and are not enabled by this customer cart endpoint.

## NestJS structure

- `src/server.ts`: application bootstrap and graceful shutdown.
- `src/app.module.ts`: root module combining the feature modules.
- `src/customers/customers.module.ts`: customer controller and injected commerce service.
- `src/carts/carts.module.ts`: cart controller and session/origin guards using the shared authentication module.
- `src/carts/cart.ts`: cart request/response validation and service interface.
- `src/auth.ts`: authentication module, controller, service, and origin/session guards.
- `src/common/api-exception.filter.ts`: global filter preserving sanitized API errors.
- `src/commercetools.ts`: commerce API client, OAuth caching, and Google customer mapping.

NestJS uses its Express platform adapter. Routes are declared in Nest controllers. Existing Zod validation, `.env` settings, API paths, and Google login page continue to work. `npm run dev` uses the Nest CLI watch server and `npm run build` uses `nest build`; `npm start` runs compiled JavaScript.

## Architecture and remaining POC increments

```text
Next.js / React Native → NestJS BFF → commercetools
                             ↓
                     Keystone / Google identity
```

`ExternalAuth` creates a commerce customer; Google sign-in authenticates the user and the BFF issues its own session. Keystone, magic links, and email OTP are not implemented. The customer creation endpoint remains a local POC endpoint without identity middleware; public deployment needs identity and abuse controls.

The remaining requirements are adding products, order confirmation, guest checkout, anonymous cart association with a customer, cart modifications, and order history. These will need session ownership checks for carts and orders. AEM, Algolia, TD Bambora, and OrderIQ are future integrations.

References: [Customers and ExternalAuth](https://docs.commercetools.com/api/projects/customers), [OAuth client credentials](https://docs.commercetools.com/api/authorization), [API scopes](https://docs.commercetools.com/api/scopes).

Google references: [Server-side ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [Google sign-in setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

## PACE Product Type importer

See [catalog/README.md](catalog/README.md) for the source analysis, provisional 64-attribute Product Type, mapping decisions, and importer commands. Run `npm run catalog:product-type -- --dry-run` to validate locally or `npm run catalog:product-type -- --apply` to create the type using `.env` credentials. This imports the schema; product record import is a later step.
