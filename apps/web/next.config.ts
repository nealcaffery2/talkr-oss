import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Local development against a deployed API whose CORS allow-list does not
  // include localhost: set DEV_API_PROXY=https://<api-host> (and point
  // NEXT_PUBLIC_API_URL at http://localhost:3100/api-proxy) and the dev server
  // forwards same-origin. Unset in every deployed build, so this adds nothing
  // to production.
  async rewrites() {
    const target = process.env.DEV_API_PROXY?.replace(/\/$/, '');
    if (!target) return [];
    return [{ source: '/api-proxy/:path*', destination: `${target}/:path*` }];
  },
  // Secure headers baseline (docs/security.md §7).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'microphone=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
