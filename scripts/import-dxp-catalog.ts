import 'dotenv/config';
import { readFile } from 'node:fs/promises';

type Raw = Record<string, any>;
const files = ['0320', '0657'];
const root = new URL('../', import.meta.url);
const productTypeKey = 'sobeys-product-type';
const importBase = `https://import.us-central1.gcp.commercetools.com/${encodeURIComponent(process.env.CT_PROJECT_KEY ?? '')}`;
const apiBase = `${process.env.CT_API_URL?.replace(/\/$/, '')}/${encodeURIComponent(process.env.CT_PROJECT_KEY ?? '')}`;

function slug(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 240) || 'product';
}
function valueFor(name: string, raw: Raw): unknown {
  if (name.startsWith('nutrition-')) return raw.nutritionalInformation?.[name.slice('nutrition-'.length)];
  if (name.startsWith('allergens-')) return raw.allergens?.[name.slice('allergens-'.length)];
  return raw[name];
}
const numeric = new Set([
  'itemPackCount', 'numberOfItemsInPack', 'priceQuantity', 'milkFatContentRoundedOffPercentage',
  'moistureContentRoundedOffPercentage', 'scaleLabelFixedWeight', 'nutrition-calciumRoundedOffValue',
  'nutrition-calciumValuePercentage', 'nutrition-caloriesRoundedOffValue', 'nutrition-carbohydratesRoundedOffValue',
  'nutrition-carbohydratesValuePercentage', 'nutrition-cholesterolRoundedOffValue', 'nutrition-cholesterolValuePercentage',
  'nutrition-fatRoundedOffValue', 'nutrition-fatValuePercentage', 'nutrition-fibreRoundedOffValue', 'nutrition-fibreValuePercentage',
  'nutrition-householdMeasureQuantity', 'nutrition-ironRoundedOffValue', 'nutrition-ironValuePercentage',
  'nutrition-metricServingSizeRoundedOffValue', 'nutrition-omega3PublishNutritional', 'nutrition-omega6PublishNutritional',
  'nutrition-polyunsaturatedPublishNutritional', 'nutrition-potassiumRoundedOffValue', 'nutrition-potassiumValuePercentage',
  'nutrition-proteinRoundedOffValue', 'nutrition-proteinValuePercentage', 'nutrition-saturatedAndTransFatRoundedOffValue',
  'nutrition-saturatedAndTransFatValuePercentage', 'nutrition-saturatedFatRoundedOffValue', 'nutrition-saturatedFatValuePercentage',
  'nutrition-sodiumRoundedOffValue', 'nutrition-sodiumValuePercentage', 'nutrition-sugarAlcoholRoundedOffValue',
  'nutrition-sugarRoundedOffValue', 'nutrition-sugarValuePercentage', 'nutrition-transFatRoundedOffValue',
  'nutrition-vitaminAValuePercentage', 'nutrition-vitaminCValuePercentage',
]);
const attrNames = new Set<string>();
const attrTypes = new Map<string, string>();
const productType = async (token: string) => {
  const response = await fetch(`${apiBase}/product-types/key=${productTypeKey}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Product Type lookup failed (${response.status})`);
  const body = await response.json();
  for (const attribute of body.attributes) { attrNames.add(attribute.name); attrTypes.set(attribute.name, attribute.type.name === 'set' ? `set:${attribute.type.elementType.name}` : attribute.type.name); }
};
function attributes(raw: Raw) {
  const result: Array<{ name: string; value: unknown }> = [];
  for (const name of attrNames) {
    let value = valueFor(name, raw);
    if (value === null || value === undefined || value === '') continue;
    const expected = attrTypes.get(name);
    if (expected === 'number') {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) continue;
      value = parsed;
    }
    if (expected === 'boolean' && typeof value === 'string') {
      if (value.toLowerCase() === 'true') value = true;
      else if (value.toLowerCase() === 'false') value = false;
      else continue;
    }
    if (expected === 'text' && typeof value !== 'string') value = String(value);
    if (name === 'nutrition-ingredients' && !Array.isArray(value)) value = [String(value)];
    if (Array.isArray(value) && value.length === 0) continue;
    result.push({ name, value });
  }
  return result;
}
async function token() {
  const basic = Buffer.from(`${process.env.CT_CLIENT_ID}:${process.env.CT_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${process.env.CT_AUTH_URL}/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: process.env.CT_SCOPES ?? '' }) });
  if (!response.ok) throw new Error(`Authentication failed (${response.status})`);
  return (await response.json()).access_token as string;
}
async function main() {
  const access = await token();
  await productType(access);
  const grouped = new Map<string, { raw: Raw; stores: Map<string, Raw> }>();
  for (const store of files) {
    const data = JSON.parse(await readFile(new URL(`Downloads/Archive/dxp_product_en_${store}.json`, 'file:///Users/shubham/'))) as Raw[];
    for (const raw of data) {
      const article = String(raw.articleNumber ?? '').trim();
      const uom = String(raw.uom ?? '').trim();
      if (!article || !uom) continue;
      const key = `${article}-${uom}`;
      const existing = grouped.get(key) ?? { raw, stores: new Map<string, Raw>() };
      existing.stores.set(String(raw.storeId), raw);
      grouped.set(key, existing);
    }
  }
  const resources = [...grouped.entries()].map(([identity, item]) => {
    const raw = item.raw; const article = String(raw.articleNumber); const uom = String(raw.uom);
    const prices = [...item.stores.entries()].map(([storeId, row]) => ({ key: `price-${identity}-${storeId}`, value: { type: 'centPrecision', currencyCode: 'CAD', centAmount: Math.max(0, Math.round(Number(row.price ?? 0) * 100)) }, country: 'CA', channel: { typeId: 'channel', key: `sobeys-${storeId}-channel` } }));
    const description = String(raw.description || '').trim();
    return { key: `product-${identity}`, productType: { typeId: 'product-type', key: productTypeKey }, name: { 'en-CA': String(raw.name || `${article} ${uom}`) }, slug: { 'en-CA': `${slug(String(raw.pageSlug || raw.name || identity))}-${article}-${uom.toLowerCase()}`.slice(0, 256) }, ...(description ? { description: { 'en-CA': description } } : {}), masterVariant: { key: identity, sku: identity, attributes: attributes(raw), prices }, publish: true };
  });
  const headers = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' };
  const containerKey = `dxp-products-${Date.now()}`;
  let response = await fetch(`${importBase}/import-containers`, { method: 'POST', headers, body: JSON.stringify({ key: containerKey, resourceType: 'product-draft' }) });
  if (!response.ok) throw new Error(`Import Container creation failed (${response.status}): ${await response.text()}`);
  const submit = async (chunk: unknown[]) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await fetch(`${importBase}/product-drafts/import-containers/${encodeURIComponent(containerKey)}`, { method: 'POST', headers, body: JSON.stringify({ type: 'product-draft', resources: chunk }) });
        if (result.ok || (result.status !== 429 && result.status < 500)) return result;
      } catch { /* retry transient network failures */ }
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
    throw new Error('Product import request failed after retries');
  };
  const batches = [] as Promise<Response>[];
  for (let i = 0; i < resources.length; i += 20) {
    const chunk = resources.slice(i, i + 20);
    batches.push(submit(chunk));
    if (batches.length >= 5) { const results = await Promise.all(batches.splice(0)); const failed = results.find(r => !r.ok); if (failed) throw new Error(`Product import request failed (${failed.status}): ${await failed.text()}`); }
  }
  const results = await Promise.all(batches); const failed = results.find(r => !r.ok); if (failed) throw new Error(`Product import request failed (${failed.status}): ${await failed.text()}`);
  console.log(JSON.stringify({ status: 'submitted', products: resources.length, importContainer: containerKey, batches: Math.ceil(resources.length / 20), prices: resources.reduce((n, p) => n + p.masterVariant.prices.length, 0), nextStep: 'Monitor Import Summary, then assign product keys to Store Product Selections.' }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'DXP import failed'); process.exitCode = 1; });
