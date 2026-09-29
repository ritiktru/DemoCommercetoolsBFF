import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { ProductImporter, productManifestSchema } from '../src/catalog/product-importer.js';
import { loadStoreImportConfig } from '../src/stores/store-importer.js';

async function main() {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !['--dry-run', '--apply'].includes(mode))) throw new Error('Usage: npm run catalog:products -- [--dry-run|--apply]');
  const input = JSON.parse(await readFile(new URL('../imports/pace-products-poc.json', import.meta.url), 'utf8'));
  const parsed = productManifestSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid product manifest: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  if (mode !== '--apply') {
    console.log(JSON.stringify({ mode: 'dry-run', products: parsed.data.products.length, skus: parsed.data.products.map(product => product.sku), priceRows: parsed.data.products.reduce((sum, product) => sum + product.prices.length, 0), categoryKeys: [...new Set(parsed.data.products.map(product => product.categoryKey))], message: 'Manifest validated locally. No network requests or commercetools writes.' }, null, 2));
    return;
  }
  const result = await new ProductImporter(loadStoreImportConfig(process.env)).apply(parsed.data);
  console.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
}

main().catch(error => {
  const message = error instanceof Error && /^(Invalid |CT_SCOPES|Importer authentication|Required |Channel lookup|Product |Existing Product)/.test(error.message) ? error.message : 'Product import failed. Check configuration and commercetools project state.';
  console.error(message); process.exitCode = 1;
});
