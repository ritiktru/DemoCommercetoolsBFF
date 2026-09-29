# Running the Sobeys commercetools POC

This repository contains two applications:

- `src/`: NestJS BFF
- `storefront/`: Next.js demo website

The storefront runs on port `3000`. The BFF runs on port `3001`.

## Requirements

- Node.js 22 or newer
- A commercetools project and API Client
- Google Web OAuth client, if testing Google sign-in

## Install dependencies

From the repository root:

```bash
npm install
cd storefront
npm install
cd ..
```




## Start the applications

Start the BFF in Terminal 1 from the repository root:

```bash
npm run dev
```

Start the storefront in Terminal 2:

```bash
cd storefront
npm run dev
```

Open the website:

```text
http://localhost:3000
```

Check the BFF directly:

```bash
curl http://127.0.0.1:3001/health
```

Expected response:

```json
{"status":"ok"}
```

## Test the demo

1. Select a Sobeys Store.
2. Browse the Store-scoped products and prices.
3. Click **Add** to create or reuse a cart.
4. Sign in with Google when testing customer-specific carts.
5. Check the cart in Merchant Center under **Orders → Carts**.

The same customer can have separate active carts for different Stores because Store carts use Store-specific prices, product selections, inventory, and fulfillment rules.

## Port and process issues

Check which process owns a port:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:3001 -sTCP:LISTEN
```

Stop a process using its displayed PID:

```bash
kill -9 PID
```

Do not start a second BFF if port `3001` already has a listener. Do not start a second storefront if port `3000` already has a listener.

## Validation commands

From the repository root:

```bash
npm run typecheck
npm test
npm run build
```

For the storefront:

```bash
cd storefront
npm run lint
```

## Sharing a private demo ZIP

Dependencies and build output are not required in the ZIP. Create it from the parent directory with:

```bash
zip -r DemoCommercetoolsBFF-demo.zip DemoCommercetoolsBFF \
  -x "DemoCommercetoolsBFF/node_modules/*" \
     "DemoCommercetoolsBFF/storefront/node_modules/*" \
     "DemoCommercetoolsBFF/.next/*" \
     "DemoCommercetoolsBFF/storefront/.next/*" \
     "DemoCommercetoolsBFF/.git/*"
```

For a private trial demo, `.env` can be included, but do not upload it publicly. The recipient should run `npm install` in the root and in `storefront` before starting the applications.

