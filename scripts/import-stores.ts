import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { loadStoreImportConfig, StoreImporter, storePackageSchema } from '../src/stores/store-importer.js';

async function main() {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !['--dry-run', '--apply'].includes(mode))) throw new Error('Usage: npm run stores:import -- [--dry-run|--apply]');
  const input = JSON.parse(await readFile(new URL('../imports/aem-sobeys-stores.json', import.meta.url), 'utf8'));
  const parsed = storePackageSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid store manifest: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  if (mode !== '--apply') {
    const regions = Object.fromEntries([...new Set(parsed.data.records.map(record => record.region))].sort().map(region => [region, parsed.data.records.filter(record => record.region === region).length]));
    console.log(JSON.stringify({ mode: 'dry-run', stores: parsed.data.records.length, channels: parsed.data.records.length, excludedDuplicates: parsed.data.excludedDuplicates, regions, message: 'Manifest validated locally. No network requests or commercetools writes.' }, null, 2));
    return;
  }
  const importer = new StoreImporter(loadStoreImportConfig(process.env));
  const result = await importer.apply(parsed.data, (complete, total) => {
    if (complete % 25 === 0 || complete === total) console.error(`Imported ${complete}/${total}`);
  });
  console.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
}

main().catch(error => {
  const message = error instanceof Error && /^(Invalid |CT_SCOPES|Importer authentication|Channel sobeys-|Store sobeys-)/.test(error.message) ? error.message : 'Store import failed. Check connectivity, configuration, and commercetools project state.';
  console.error(message);
  process.exitCode = 1;
});
