import 'dotenv/config';

const env = process.env;
for (const name of ['CT_PROJECT_KEY', 'CT_CLIENT_ID', 'CT_CLIENT_SECRET', 'CT_AUTH_URL', 'CT_API_URL']) if (!env[name]) throw new Error(`${name} is required`);
const project = env.CT_PROJECT_KEY!;
const api = `${env.CT_API_URL!.replace(/\/$/, '')}/${encodeURIComponent(project)}`;
const customTypeKey = env.DELIVERY_PASS_CUSTOM_TYPE_KEY ?? 'sobeys-delivery-pass';
const productTypeKey = env.DELIVERY_PASS_PRODUCT_TYPE_KEY ?? 'sobeys-pace-product-v1';
const productKey = env.DELIVERY_PASS_PRODUCT_KEY ?? 'sobeys-delivery-pass-12m';
const sku = env.DELIVERY_PASS_SKU ?? 'DELIVERY-PASS-12M';
const priceCents = Number(env.DELIVERY_PASS_PRICE_CENTS ?? 4999);

const auth = await fetch(`${env.CT_AUTH_URL!.replace(/\/$/, '')}/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.CT_CLIENT_ID}:${env.CT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: env.CT_SCOPES ?? `manage_project:${project}` }) });
if (!auth.ok) throw new Error('Unable to authenticate with commercetools');
const access = (await auth.json() as { access_token: string }).access_token;
async function ct(path: string, init?: RequestInit) { return fetch(`${api}${path}`, { ...init, headers: { Authorization: `Bearer ${access}`, Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } }); }
async function error(response: Response) { try { const body = await response.json() as { message?: string; errors?: Array<{ code?: string; message?: string }> }; return body.errors?.map(item => `${item.code}: ${item.message}`).join('; ') || body.message || `HTTP ${response.status}`; } catch { return `HTTP ${response.status}`; } }
async function byKey(path: string, key: string) { const response = await ct(`${path}/key=${encodeURIComponent(key)}`); if (response.status === 404) return undefined; if (!response.ok) throw new Error(`Unable to read ${path}: ${await error(response)}`); return await response.json() as { id: string; version: number; key: string }; }

let customType = await byKey('/types', customTypeKey);
if (!customType) {
  const response = await ct('/types', { method: 'POST', body: JSON.stringify({ key: customTypeKey, name: { en: 'Sobeys Delivery Pass' }, resourceTypeIds: ['customer'], fieldDefinitions: [
    { name: 'deliveryPassActive', label: { en: 'Delivery Pass active' }, required: false, type: { name: 'Boolean' }, inputHint: 'SingleLine' },
    { name: 'deliveryPassExpiresAt', label: { en: 'Delivery Pass expiry' }, required: false, type: { name: 'DateTime' }, inputHint: 'SingleLine' },
    { name: 'deliveryPassOrderId', label: { en: 'Delivery Pass order' }, required: false, type: { name: 'String' }, inputHint: 'SingleLine' },
  ] }) });
  if (!response.ok) throw new Error(`Unable to create Customer Custom Type: ${await error(response)}`);
  customType = await response.json() as typeof customType;
}
if (!await byKey('/product-types', productTypeKey)) throw new Error(`Product Type ${productTypeKey} was not found`);
let product = await byKey('/products', productKey);
if (!product) {
  const response = await ct('/products', { method: 'POST', body: JSON.stringify({ productType: { typeId: 'product-type', key: productTypeKey }, key: productKey, name: { en: 'Sobeys Delivery Pass (12 months)' }, slug: { en: productKey }, masterVariant: { sku, attributes: [{ name: 'pace-articleNumber', value: sku }, { name: 'pace-uom', value: 'EA' }], prices: [{ value: { currencyCode: 'CAD', centAmount: priceCents } }] } }) });
  if (!response.ok) throw new Error(`Unable to create Delivery Pass Product: ${await error(response)}`);
  product = await response.json() as typeof product;
}
const taxResponse = await ct('/tax-categories?limit=100');
if (!taxResponse.ok) throw new Error(`Unable to read Tax Categories: ${await error(taxResponse)}`);
const taxes = (await taxResponse.json() as { results: Array<{ id: string; key: string; name: string }> }).results;
const tax = taxes.find(item => /standard/i.test(item.name) || /standard/i.test(item.key)) ?? taxes[0];
if (!tax) throw new Error('No Tax Category exists in the project');
const taxUpdate = await ct(`/products/${product!.id}`, { method: 'POST', body: JSON.stringify({ version: product!.version, actions: [{ action: 'setTaxCategory', taxCategory: { typeId: 'tax-category', id: tax.id } }] }) });
if (taxUpdate.ok) product = await taxUpdate.json() as typeof product;
const publish = await ct(`/products/${product!.id}`, { method: 'POST', body: JSON.stringify({ version: product!.version, actions: [{ action: 'publish' }] }) });
if (!publish.ok && publish.status !== 400) throw new Error(`Unable to publish Delivery Pass Product: ${await error(publish)}`);
console.log(JSON.stringify({ customTypeKey, productTypeKey, productKey, sku, priceCents }, null, 2));
