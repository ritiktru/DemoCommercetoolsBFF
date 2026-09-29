import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { draftSchema, loadImportConfig, ProductTypeImporter } from '../src/catalog/product-type-importer.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--dry-run', '--apply'].includes(args[0]))) {
    throw new Error('Usage: npm run catalog:product-type -- [--dry-run|--apply]');
  }
  const parsed = draftSchema.safeParse(JSON.parse(await readFile(new URL('../catalog/sobeys-pace-product-type.json', import.meta.url), 'utf8')));
  if (!parsed.success) throw new Error(`Invalid schema: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  const draft = parsed.data;
  if (args[0] !== '--apply') {
    console.log(JSON.stringify({ mode: 'dry-run', key: draft.key, name: draft.name, attributes: draft.attributes.length, required: draft.attributes.filter(attr => attr.isRequired).map(attr => attr.name), schema: 'catalog/sobeys-pace-product-type.json', message: 'Schema validated locally. No network requests or project writes.' }, null, 2));
    return;
  }
  const importer = new ProductTypeImporter(loadImportConfig(process.env));
  try { console.log(JSON.stringify(await importer.apply(draft), null, 2)); }
  catch (error) {
    // Only our explicit sanitized errors can reach stdout; fetch/Zod errors may contain request details.
    const message = error instanceof Error && /^(Importer authentication|Unable to read Product Type|Product Type |Existing Product Type)/.test(error.message)
      ? error.message : 'Importer request failed. Check network/configuration and verify project state before retrying.';
    throw new Error(message);
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Product Type importer failed');
  process.exitCode = 1;
});
