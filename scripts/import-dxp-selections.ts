import 'dotenv/config';
import { readFile } from 'node:fs/promises';
type Raw = Record<string, any>;
const importBase = `https://import.us-central1.gcp.commercetools.com/${encodeURIComponent(process.env.CT_PROJECT_KEY ?? '')}`;
async function main() {
  const basic = Buffer.from(`${process.env.CT_CLIENT_ID}:${process.env.CT_CLIENT_SECRET}`).toString('base64');
  const auth = await fetch(`${process.env.CT_AUTH_URL}/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: process.env.CT_SCOPES ?? '' }) });
  const { access_token: token } = await auth.json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const resources = [] as any[];
  for (const store of ['0320', '0657']) {
    const data = JSON.parse(await readFile(new URL(`Downloads/Archive/dxp_product_en_${store}.json`, 'file:///Users/shubham/'))) as Raw[];
    const keys = [...new Set(data.filter(row => row.isVisible === true && String(row.channel ?? '').split(',').includes('Voila')).map(row => `product-${String(row.articleNumber).trim()}-${String(row.uom).trim()}`))];
    resources.push({ key: `sobeys-${store}-assortment`, name: { 'en-CA': `Sobeys ${store} Assortment` }, mode: 'Individual', assignments: keys.map(key => ({ product: { key, typeId: 'product' }, variantSelection: { type: 'includeOnly', skus: [key.slice('product-'.length)] } })) });
  }
  const containerKey = `dxp-selections-${Date.now()}`;
  let response = await fetch(`${importBase}/import-containers`, { method: 'POST', headers, body: JSON.stringify({ key: containerKey, resourceType: 'product-selection' }) });
  if (!response.ok) throw new Error(`Selection Import Container failed (${response.status}): ${await response.text()}`);
  response = await fetch(`${importBase}/product-selections/import-containers/${encodeURIComponent(containerKey)}`, { method: 'POST', headers, body: JSON.stringify({ type: 'product-selection', resources }) });
  if (!response.ok) throw new Error(`Selection import request failed (${response.status}): ${await response.text()}`);
  console.log(JSON.stringify({ status: 'submitted', importContainer: containerKey, selections: resources.map(r => ({ key: r.key, assignments: r.assignments.length })) }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Selection import failed'); process.exitCode = 1; });
