import 'dotenv/config';

const env = process.env;
for (const name of ['CT_PROJECT_KEY', 'CT_CLIENT_ID', 'CT_CLIENT_SECRET', 'CT_AUTH_URL', 'CT_API_URL']) if (!env[name]) throw new Error(`${name} is required`);
const project = env.CT_PROJECT_KEY!;
const typeKey = env.DELIVERY_PASS_CUSTOM_TYPE_KEY ?? 'sobeys-delivery-pass';
const auth = await fetch(`${env.CT_AUTH_URL!.replace(/\/$/, '')}/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.CT_CLIENT_ID}:${env.CT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: env.CT_SCOPES ?? `manage_project:${project}` }) });
if (!auth.ok) throw new Error('Unable to authenticate with commercetools');
const token = (await auth.json() as { access_token: string }).access_token;
const api = `${env.CT_API_URL!.replace(/\/$/, '')}/${encodeURIComponent(project)}`;
async function ct(path: string, init?: RequestInit) { return fetch(`${api}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } }); }
async function error(response: Response) { try { return (await response.json() as { message?: string }).message ?? `HTTP ${response.status}`; } catch { return `HTTP ${response.status}`; } }

const response = await ct(`/types/key=${encodeURIComponent(typeKey)}`);
if (response.status === 404) throw new Error(`Customer Custom Type ${typeKey} does not exist. Run npm run delivery-pass:setup first.`);
if (!response.ok) throw new Error(`Unable to read Customer Custom Type: ${await error(response)}`);
const type = await response.json() as { id: string; version: number; fieldDefinitions: Array<{ name: string }> };
if (!type.fieldDefinitions.some(field => field.name === 'rewardPointsBalance')) {
  const update = await ct(`/types/${type.id}`, { method: 'POST', body: JSON.stringify({ version: type.version, actions: [{ action: 'addFieldDefinition', fieldDefinition: { name: 'rewardPointsBalance', label: { en: 'Reward points balance' }, required: false, type: { name: 'Number' }, inputHint: 'SingleLine' } }] }) });
  if (!update.ok) throw new Error(`Unable to add rewardPointsBalance: ${await error(update)}`);
  console.log(`Added rewardPointsBalance to ${typeKey}.`);
} else console.log(`rewardPointsBalance already exists on ${typeKey}.`);
