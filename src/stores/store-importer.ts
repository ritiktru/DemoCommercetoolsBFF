import { z } from 'zod';

const keySchema = z.string().min(2).max(256).regex(/^[A-Za-z0-9_-]+$/);
const addressSchema = z.object({
  address1: z.string().trim().min(1),
  address2: z.string().nullable().optional(),
  city: z.string().trim().min(1),
  province: z.string().trim().length(2),
  postalCode: z.string().trim().min(3),
  phone: z.string().trim().min(7),
}).passthrough();
const sourceRecordSchema = z.object({
  folder: z.string().min(1), path: z.string().min(1), storeNumber: z.string().regex(/^\d+$/),
  storeName: z.string().trim().min(1), region: z.string().trim().min(1),
  distributionChannel: z.string().nullable().optional(), address: addressSchema,
  geoloc: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
});
export const storePackageSchema = z.object({
  schemaVersion: z.literal(1), source: z.string().min(1),
  records: z.array(sourceRecordSchema).min(1),
  excludedDuplicates: z.array(z.object({
    storeNumber: z.string(), folder: z.string(), storeName: z.string(), reason: z.string(),
  })),
}).superRefine((data, ctx) => {
  const numbers = new Set<string>();
  for (const [index, record] of data.records.entries()) {
    if (numbers.has(record.storeNumber)) ctx.addIssue({ code: 'custom', message: 'Duplicate store number', path: ['records', index, 'storeNumber'] });
    numbers.add(record.storeNumber);
    if (record.region === '\\0') ctx.addIssue({ code: 'custom', message: 'Invalid region', path: ['records', index, 'region'] });
  }
});
export type StorePackage = z.infer<typeof storePackageSchema>;

const origin = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
});
const configSchema = z.object({
  CT_PROJECT_KEY: z.string().trim().min(1), CT_CLIENT_ID: z.string().trim().min(1),
  CT_CLIENT_SECRET: z.string().min(1), CT_AUTH_URL: origin, CT_API_URL: origin,
  CT_SCOPES: z.string().trim().min(1),
});
type ImportConfig = z.infer<typeof configSchema>;
export function loadStoreImportConfig(env: NodeJS.ProcessEnv): ImportConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid importer environment: ${[...new Set(parsed.error.issues.map(issue => issue.path.join('.')))].join(', ')}`);
  const scopes = parsed.data.CT_SCOPES.split(/\s+/);
  const project = parsed.data.CT_PROJECT_KEY;
  const allowed = (permission: string) => scopes.includes(`${permission}:${project}`);
  if (!allowed('manage_project') && !(allowed('manage_channels') && allowed('manage_stores'))) {
    throw new Error('CT_SCOPES must include manage_project, or both manage_channels and manage_stores, for CT_PROJECT_KEY');
  }
  return parsed.data;
}

const channelResponseSchema = z.object({
  id: z.string(), version: z.number().int().positive(), key: keySchema,
  roles: z.array(z.string()), name: z.record(z.string(), z.string()).optional(),
  address: z.object({ country: z.string(), streetName: z.string().optional(), additionalStreetInfo: z.string().optional(), city: z.string().optional(), state: z.string().optional(), postalCode: z.string().optional(), phone: z.string().optional() }).passthrough().optional(),
  geoLocation: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }).optional(),
});
const storeResponseSchema = z.object({
  id: z.string(), version: z.number().int().positive(), key: keySchema,
  name: z.record(z.string(), z.string()).optional(), languages: z.array(z.string()),
  countries: z.array(z.object({ code: z.string() })),
  distributionChannels: z.array(z.object({ id: z.string() })), supplyChannels: z.array(z.object({ id: z.string() })),
});
type ImportResult = { channels: Record<'created' | 'updated' | 'unchanged', number>; stores: Record<'created' | 'updated' | 'unchanged', number>; excluded: number };

function channelDraft(record: z.infer<typeof sourceRecordSchema>) {
  return {
    key: `sobeys-${record.storeNumber}-channel`, roles: ['ProductDistribution', 'InventorySupply'],
    name: { 'en-CA': record.storeName },
    address: {
      country: 'CA', streetName: record.address.address1,
      ...(record.address.address2?.trim() ? { additionalStreetInfo: record.address.address2.trim() } : {}),
      city: record.address.city, state: record.address.province,
      postalCode: record.address.postalCode.replace(/\s+/g, '').toUpperCase(), phone: record.address.phone,
    },
    geoLocation: { type: 'Point' as const, coordinates: [record.geoloc.lng, record.geoloc.lat] as [number, number] },
  };
}
function storeDraft(record: z.infer<typeof sourceRecordSchema>, channelId: string) {
  const channel = { typeId: 'channel', id: channelId };
  return {
    key: `sobeys-${record.storeNumber}`, name: { 'en-CA': record.storeName }, languages: ['en-CA'], countries: [{ code: 'CA' }],
    distributionChannels: [channel], supplyChannels: [channel],
  };
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export class StoreImporter {
  private token = '';
  private readonly apiBase: string;
  constructor(private readonly config: ImportConfig, private readonly fetcher: typeof fetch = fetch) {
    this.apiBase = `${config.CT_API_URL.replace(/\/$/, '')}/${encodeURIComponent(config.CT_PROJECT_KEY)}`;
  }

  private async authenticate(): Promise<void> {
    const response = await this.fetcher(`${this.config.CT_AUTH_URL.replace(/\/$/, '')}/oauth/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Basic ${Buffer.from(`${this.config.CT_CLIENT_ID}:${this.config.CT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.config.CT_SCOPES }),
    });
    if (!response.ok) throw new Error(`Importer authentication failed (HTTP ${response.status})`);
    this.token = z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.fetcher(`${this.apiBase}${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${this.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
      if (response.status !== 429 || attempt === 3) return response;
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw new Error('Unexpected retry state');
  }

  private async read(kind: 'channels' | 'stores', key: string): Promise<Response> {
    return this.request(`/${kind}/key=${encodeURIComponent(key)}`);
  }

  private async upsertChannel(record: z.infer<typeof sourceRecordSchema>): Promise<{ id: string; status: 'created' | 'updated' | 'unchanged' }> {
    const draft = channelDraft(record);
    let response = await this.read('channels', draft.key);
    if (response.status === 404) {
      response = await this.request('/channels', { method: 'POST', body: JSON.stringify(draft) });
      if (!response.ok) throw new Error(`Channel ${draft.key} creation failed (HTTP ${response.status})`);
      return { id: channelResponseSchema.parse(await response.json()).id, status: 'created' };
    }
    if (!response.ok) throw new Error(`Channel ${draft.key} read failed (HTTP ${response.status})`);
    const current = channelResponseSchema.parse(await response.json());
    const actions: object[] = [];
    if (!same(current.name, draft.name)) actions.push({ action: 'changeName', name: draft.name });
    if (!same([...current.roles].sort(), [...draft.roles].sort())) actions.push({ action: 'setRoles', roles: draft.roles });
    const address = current.address && { country: current.address.country, streetName: current.address.streetName, ...(current.address.additionalStreetInfo ? { additionalStreetInfo: current.address.additionalStreetInfo } : {}), city: current.address.city, state: current.address.state, postalCode: current.address.postalCode, phone: current.address.phone };
    if (!same(address, draft.address)) actions.push({ action: 'setAddress', address: draft.address });
    if (!same(current.geoLocation, draft.geoLocation)) actions.push({ action: 'setGeoLocation', geoLocation: draft.geoLocation });
    if (!actions.length) return { id: current.id, status: 'unchanged' };
    response = await this.request(`/channels/${encodeURIComponent(current.id)}`, { method: 'POST', body: JSON.stringify({ version: current.version, actions }) });
    if (!response.ok) throw new Error(`Channel ${draft.key} update failed (HTTP ${response.status})`);
    return { id: channelResponseSchema.parse(await response.json()).id, status: 'updated' };
  }

  private async upsertStore(record: z.infer<typeof sourceRecordSchema>, channelId: string): Promise<'created' | 'updated' | 'unchanged'> {
    const draft = storeDraft(record, channelId);
    let response = await this.read('stores', draft.key);
    if (response.status === 404) {
      response = await this.request('/stores', { method: 'POST', body: JSON.stringify(draft) });
      if (!response.ok) throw new Error(`Store ${draft.key} creation failed (HTTP ${response.status})`);
      storeResponseSchema.parse(await response.json());
      return 'created';
    }
    if (!response.ok) throw new Error(`Store ${draft.key} read failed (HTTP ${response.status})`);
    const current = storeResponseSchema.parse(await response.json());
    const actions: object[] = [];
    if (!same(current.name, draft.name)) actions.push({ action: 'setName', name: draft.name });
    if (!same(current.languages, draft.languages)) actions.push({ action: 'setLanguages', languages: draft.languages });
    if (!same(current.countries, draft.countries)) actions.push({ action: 'setCountries', countries: draft.countries });
    if (!same(current.distributionChannels.map(item => item.id), [channelId])) actions.push({ action: 'setDistributionChannels', distributionChannels: draft.distributionChannels });
    if (!same(current.supplyChannels.map(item => item.id), [channelId])) actions.push({ action: 'setSupplyChannels', supplyChannels: draft.supplyChannels });
    if (!actions.length) return 'unchanged';
    response = await this.request(`/stores/${encodeURIComponent(current.id)}`, { method: 'POST', body: JSON.stringify({ version: current.version, actions }) });
    if (!response.ok) throw new Error(`Store ${draft.key} update failed (HTTP ${response.status})`);
    storeResponseSchema.parse(await response.json());
    return 'updated';
  }

  async apply(source: StorePackage, onProgress?: (complete: number, total: number) => void): Promise<ImportResult> {
    const validated = storePackageSchema.parse(source);
    await this.authenticate();
    const result: ImportResult = { channels: { created: 0, updated: 0, unchanged: 0 }, stores: { created: 0, updated: 0, unchanged: 0 }, excluded: validated.excludedDuplicates.length };
    let complete = 0;
    for (const record of validated.records) {
      const channel = await this.upsertChannel(record);
      result.channels[channel.status]++;
      const storeStatus = await this.upsertStore(record, channel.id);
      result.stores[storeStatus]++;
      onProgress?.(++complete, validated.records.length);
    }
    return result;
  }
}
