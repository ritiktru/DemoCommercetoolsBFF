import { cacheLife } from 'next/cache';
import { connection } from 'next/server';
import { bffJson, cacheHeaders, unavailable } from '../../../../../../lib/bff';

// Products and prices are the same for every shopper, so one 15-minute entry per Store is shared.
async function loadProducts(storeKey: string) {
  'use cache';
  cacheLife({ stale: 900, revalidate: 900, expire: 3600 });
  return bffJson(`/api/storefront/stores/${storeKey}/products`);
}
export async function GET(_request: Request, { params }: { params: Promise<{ storeKey: string }> }) {
  await connection();
  const { storeKey } = await params;
  if (!/^[A-Za-z0-9_-]{2,256}$/.test(storeKey)) return Response.json({ error: { code: 'StoreNotFound', message: 'Store not found' } }, { status: 404 });
  try { return Response.json(await loadProducts(storeKey), { headers: cacheHeaders }); } catch (error) { return unavailable(error); }
}
