import { cacheLife } from 'next/cache';
import { connection } from 'next/server';
import { bffJson, cacheHeaders, unavailable } from '../../../../lib/bff';

async function loadStores() {
  'use cache';
  cacheLife({ stale: 900, revalidate: 900, expire: 3600 });
  return bffJson('/api/storefront/stores');
}
export async function GET() {
  await connection(); // resolve at request time, not at build, so the build never needs the BFF running
  try { return Response.json(await loadStores(), { headers: cacheHeaders }); } catch (error) { return unavailable(error); }
}
