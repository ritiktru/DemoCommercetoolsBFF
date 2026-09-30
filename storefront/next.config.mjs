const BFF_URL = process.env.BFF_URL ?? 'http://127.0.0.1:3001';
const nextConfig = {
  cacheComponents: true,
  // Cached GET routes for stores, promotion and products live in app/api. `fallback` rewrites run only after
  // every route (including dynamic ones) has failed to match, so those routes are never shadowed by the proxy.
  // Note: this destination is fixed at build time; BFF_URL must be set when running `next build`.
  async rewrites() {
    return { fallback: [{ source: '/api/:path*', destination: `${BFF_URL}/api/:path*` }] };
  },
};
export default nextConfig;
