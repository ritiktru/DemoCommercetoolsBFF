import { z } from 'zod';

const identifier = z.string().min(2).max(256).regex(/^[A-Za-z0-9_-]+$/);
const scalarType = z.object({ name: z.enum(['text', 'boolean', 'number']) });
const type = z.union([scalarType, z.object({ name: z.literal('set'), elementType: scalarType })]);
const attribute = z.object({
  name: identifier, label: z.record(z.string(), z.string().min(1)).refine(value => Object.keys(value).length > 0),
  type, isRequired: z.boolean(), attributeConstraint: z.literal('None'),
  isSearchable: z.boolean(), level: z.literal('Variant'),
});
export const draftSchema = z.object({
  key: identifier, name: z.string().min(1), description: z.string().min(1),
  attributes: z.array(attribute).min(1),
}).superRefine((draft, ctx) => {
  const seen = new Set<string>();
  for (const [index, attr] of draft.attributes.entries()) {
    if (seen.has(attr.name)) ctx.addIssue({ code: 'custom', message: 'Duplicate attribute name', path: ['attributes', index, 'name'] });
    seen.add(attr.name);
  }
});
export type ProductTypeDraft = z.infer<typeof draftSchema>;
const resultSchema = z.object({
  id: z.string().min(1), version: z.number().int().positive(), key: identifier,
  name: z.string(), description: z.string(),
  attributes: z.array(attribute.extend({
    level: z.literal('Variant').default('Variant'),
    attributeConstraint: z.literal('None').default('None'),
    isSearchable: z.boolean().default(true),
  })),
});
const origin = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
});
const configSchema = z.object({
  CT_PROJECT_KEY: z.string().trim().min(1), CT_CLIENT_ID: z.string().trim().min(1),
  CT_CLIENT_SECRET: z.string().min(1), CT_AUTH_URL: origin, CT_API_URL: origin,
  CT_SCOPES: z.string().trim().min(1),
});
export type ImportConfig = z.infer<typeof configSchema>;
export function loadImportConfig(env: NodeJS.ProcessEnv): ImportConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) throw new Error(`Invalid importer environment: ${[...new Set(result.error.issues.map(i => i.path.join('.')))].join(', ')}`);
  const { CT_PROJECT_KEY: project, CT_SCOPES: scopes } = result.data;
  if (!scopes.split(/\s+/).some(scope => ['manage_project', 'manage_products', 'manage_product_types'].some(permission => scope === `${permission}:${project}`))) {
    throw new Error('CT_SCOPES must include manage_product_types, manage_products, or manage_project for CT_PROJECT_KEY');
  }
  return result.data;
}
function canonical(draft: ProductTypeDraft): string {
  return JSON.stringify({
    key: draft.key, name: draft.name, description: draft.description,
    attributes: [...draft.attributes].sort((a, b) => a.name.localeCompare(b.name)).map(attr => ({
      name: attr.name, label: Object.fromEntries(Object.entries(attr.label).sort(([a], [b]) => a.localeCompare(b))),
      type: attr.type.name === 'set' ? { name: 'set', elementType: { name: attr.type.elementType.name } } : { name: attr.type.name },
      isRequired: attr.isRequired, attributeConstraint: attr.attributeConstraint,
      isSearchable: attr.isSearchable, level: attr.level,
    })),
  });
}
export class ProductTypeImporter {
  constructor(private readonly config: ImportConfig, private readonly fetcher: typeof fetch = fetch) {}

  async apply(input: ProductTypeDraft): Promise<{ status: 'created' | 'unchanged'; id: string; key: string; version: number; attributeCount: number }> {
    const draft = draftSchema.parse(input);
    const tokenResponse = await this.fetcher(`${this.config.CT_AUTH_URL.replace(/\/$/, '')}/oauth/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Basic ${Buffer.from(`${this.config.CT_CLIENT_ID}:${this.config.CT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.config.CT_SCOPES }),
    });
    if (!tokenResponse.ok) throw new Error(`Importer authentication failed (HTTP ${tokenResponse.status}). Check API Client credentials and scopes.`);
    const { access_token } = z.object({ access_token: z.string().min(1) }).parse(await tokenResponse.json());
    const base = `${this.config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(this.config.CT_PROJECT_KEY)}/product-types`;
    const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
    const read = () => this.fetcher(`${base}/key=${encodeURIComponent(draft.key)}`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    const summarize = (raw: unknown, status: 'created' | 'unchanged') => {
      const parsed = resultSchema.safeParse(raw);
      if (!parsed.success) throw new Error('Product Type response is incompatible with the reviewed schema. No existing attributes were changed.');
      const existing = parsed.data;
      if (canonical(existing) !== canonical(draft)) throw new Error(`Existing Product Type ${draft.key} differs from the reviewed schema. No changes applied; use a reviewed migration or a new key.`);
      return { status, id: existing.id, key: existing.key, version: existing.version, attributeCount: existing.attributes.length };
    };
    const existing = await read();
    if (existing.ok) return summarize(await existing.json(), 'unchanged');
    if (existing.status !== 404) throw new Error(`Unable to read Product Type (HTTP ${existing.status}). Check permissions.`);
    const created = await this.fetcher(base, { method: 'POST', headers, body: JSON.stringify(draft), redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (created.status === 409) {
      const raced = await read();
      if (raced.ok) return summarize(await raced.json(), 'unchanged');
      throw new Error('Product Type creation conflicted. Verify project state before retrying.');
    }
    if (!created.ok) {
      // Only safe API error codes are surfaced; never print upstream bodies or credentials.
      let codes: string[] = [];
      try {
        const body = z.object({ errors: z.array(z.object({ code: z.string().regex(/^[A-Za-z]+$/) })) }).safeParse(await created.json());
        if (body.success) codes = body.data.errors.map(error => error.code);
      } catch { /* A non-JSON upstream response is still sanitized. */ }
      throw new Error(`Product Type creation failed (HTTP ${created.status}${codes.length ? `; ${codes.join(', ')}` : ''}). Check schema and project attribute compatibility. No automatic write retry was performed.`);
    }
    return summarize(await created.json(), 'created');
  }
}
