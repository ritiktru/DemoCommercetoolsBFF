import 'dotenv/config';
import { readFile } from 'node:fs/promises';
type Raw = Record<string, any>;
const project = encodeURIComponent(process.env.CT_PROJECT_KEY ?? '');
const apiBase = `${process.env.CT_API_URL?.replace(/\/$/, '')}/${project}`;
const files = ['0320', '0657'];
async function main() {
  const basic = Buffer.from(`${process.env.CT_CLIENT_ID}:${process.env.CT_CLIENT_SECRET}`).toString('base64');
  const auth = await fetch(`${process.env.CT_AUTH_URL}/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: process.env.CT_SCOPES ?? '' }) });
  const { access_token: token } = await auth.json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (const store of files) {
    const data = JSON.parse(await readFile(new URL(`Downloads/Archive/dxp_product_en_${store}.json`, 'file:///Users/shubham/'))) as Raw[];
    const candidateKeys = [...new Set(data.filter(row => row.isVisible === true && String(row.channel ?? '').split(',').includes('Voila')).map(row => `product-${String(row.articleNumber).trim()}-${String(row.uom).trim()}`))];
    const keys: string[] = [];
    for (let i = 0; i < candidateKeys.length; i += 20) {
      const results = await Promise.all(candidateKeys.slice(i, i + 20).map(async key => {
        const response = await fetch(`${apiBase}/products/key=${encodeURIComponent(key)}`, { headers });
        return response.ok ? key : undefined;
      }));
      keys.push(...results.filter((key): key is string => Boolean(key)));
    }
    let selectionResponse = await fetch(`${apiBase}/product-selections/key=sobeys-${store}-assortment`, { headers });
    if (!selectionResponse.ok) throw new Error(`Selection lookup failed for ${store} (${selectionResponse.status})`);
    let selection = await selectionResponse.json(); let applied = 0;
    for (let i = 0; i < keys.length; i += 200) {
      const actions = keys.slice(i, i + 200).map(key => ({ action: 'addProduct', product: { typeId: 'product', key } }));
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await fetch(`${apiBase}/product-selections/${selection.id}`, { method: 'POST', headers, body: JSON.stringify({ version: selection.version, actions }) });
        if (response.ok) { selection = await response.json(); applied += actions.length; break; }
        if (response.status === 409 || response.status === 429 || response.status >= 500) { await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); selectionResponse = await fetch(`${apiBase}/product-selections/${selection.id}`, { headers }); if (selectionResponse.ok) selection = await selectionResponse.json(); continue; }
        throw new Error(`Selection assignment failed for ${store} (${response.status}): ${await response.text()}`);
      }
    }
    console.log(JSON.stringify({ store, selectionKey: `sobeys-${store}-assortment`, visibleVoilaProducts: keys.length, assignmentsApplied: applied, finalProductCount: selection.productCount }, null, 2));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Selection assignment failed'); process.exitCode = 1; });
