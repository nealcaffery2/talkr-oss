/**
 * Package the API for a serverless host: one bundled function, the SQL
 * migrations beside it, and a package.json that names only the real runtime
 * dependencies (the host installs those; the workspace packages are bundled in).
 *
 *   node scripts/bundle-serverless.mjs [outDir]      # default dist-serverless
 *
 * Add config/talkr.env.json to the output for a host without env vars; see
 * src/serverless.ts.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..');
const repo = join(server, '..', '..');
// `--inplace` writes api/ and migrations/ into apps/server itself, which is
// what a git-linked host (Vercel, root directory apps/server) builds from; the
// committed vercel.json and config/ stay as they are.
const inplace = process.argv.includes('--inplace');
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const out = inplace ? server : outArg ? join(process.cwd(), outArg) : join(server, 'dist-serverless');

if (inplace) {
  rmSync(join(out, 'api'), { recursive: true, force: true });
  rmSync(join(out, 'migrations'), { recursive: true, force: true });
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'config'), { recursive: true });
}
mkdirSync(join(out, 'api'), { recursive: true });

await build({
  entryPoints: [join(server, 'src/serverless.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(out, 'api/index.mjs'),
  logLevel: 'info',
  minify: process.env.MINIFY === '1',
  plugins: [
    {
      // Workspace packages are bundled from source; everything else is a real
      // dependency the host installs.
      name: 'workspace-only',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@talkr/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

// Only the SQL: the drizzle snapshots beside it are for generating migrations, not running them.
cpSync(join(repo, 'packages/db/migrations'), join(out, 'migrations'), {
  recursive: true,
  filter: (src) => !src.includes('/meta'),
});

if (inplace) {
  console.log('bundled in place:', join(out, 'api/index.mjs'));
  process.exit(0);
}

const deps = {};
for (const f of [
  'apps/server/package.json',
  'packages/core/package.json',
  'packages/db/package.json',
  'packages/provider-telnyx/package.json',
]) {
  const pkg = JSON.parse(readFileSync(join(repo, f), 'utf8'));
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!name.startsWith('@talkr/')) deps[name] = version;
  }
}
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    { name: 'talkr-platform-api', private: true, type: 'module', engines: { node: '22.x' }, dependencies: deps },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  join(out, 'vercel.json'),
  JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      functions: { 'api/index.mjs': { maxDuration: 60, includeFiles: '{config,migrations}/**' } },
      rewrites: [{ source: '/(.*)', destination: '/api/index' }],
      crons: [{ path: '/internal/tick', schedule: '* * * * *' }],
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(join(out, '.gitignore'), 'config/\n');
console.log('bundled to', out, 'deps:', Object.keys(deps).join(', '));
