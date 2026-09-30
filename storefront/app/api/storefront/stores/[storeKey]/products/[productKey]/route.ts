import { cacheLife } from 'next/cache';
import { connection } from 'next/server';
import { bffJson, cacheHeaders, unavailable } from '../../../../../../../lib/bff';

// Same for every shopper, so one 15-minute entry per Store and product is shared.
async function loadProduct(storeKey: string, productKey: string) {
  'use cache';
  cacheLife({ stale: 900, revalidate: 900, expire: 3600 });
  return bffJson(`/api/storefront/stores/${storeKey}/products/${productKey}`);
}
export async function GET(_request: Request, { params }: { params: Promise<{ storeKey: string; productKey: string }> }) {
  await connection();
  const { storeKey, productKey } = await params;
  if (!/^[A-Za-z0-9_-]{2,256}$/.test(storeKey) || !/^[A-Za-z0-9_-]{1,256}$/.test(productKey)) return Response.json({ error: { code: 'ProductNotFound', message: 'Product not found' } }, { status: 404 });
  try { return Response.json(await loadProduct(storeKey, productKey), { headers: cacheHeaders }); } catch (error) { return unavailable(error); }
}
