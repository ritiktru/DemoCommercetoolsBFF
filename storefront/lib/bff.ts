export const BFF_URL = process.env.BFF_URL ?? 'http://127.0.0.1:3001';
// Server-side read of a public, shopper-independent BFF resource. Throws on failure so errors are never cached.
export async function bffJson(path: string) {
  const response = await fetch(`${BFF_URL}${path}`);
  if (!response.ok) throw Object.assign(new Error(`BFF ${response.status}`), { status: response.status });
  return response.json();
}
export const cacheHeaders = { 'Cache-Control': 'public, max-age=900' };
export const unavailable = (error?: unknown) => (error as { status?: number })?.status === 404
  ? Response.json({ error: { code: 'NotFound', message: 'Not found' } }, { status: 404 })
  : Response.json({ error: { code: 'Unavailable', message: 'Unable to load right now' } }, { status: 502 });
