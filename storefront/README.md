# Sobeys commerce POC storefront

The Next.js app runs on port 3000 and proxies `/api` to the NestJS BFF on port 3001. commercetools credentials remain in the BFF root `.env`.

From the repository root, start the BFF:

```bash
PORT=3001 npm run dev
```

In a second terminal:

```bash
cd storefront
npm install
npm run dev
```

Open http://localhost:3000. `APP_ORIGIN` in the root `.env` must be `http://localhost:3000`, which also matches the Google OAuth JavaScript origin used by this POC.
