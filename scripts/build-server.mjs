// Builds the production game server: `npm run build:server`.
//
// The workspace packages are TypeScript source with no build step of their own.
// This bundles the server's entry point and every workspace package it uses
// into plain JavaScript in dist/server, and leaves third-party dependencies as
// ordinary imports, to be installed in the runtime image with
// `npm ci --omit=dev`.
//
// The output is split into chunks so that code loaded on demand stays on
// demand: the Sentry SDK and the model code are imported only when they are
// switched on, and a single-file bundle would load them at start-up.
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist', 'server');

// Every third-party dependency of every workspace package stays external.
const external = new Set();
for (const name of readdirSync(join(root, 'packages'))) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@touchgrass/')) continue;
    external.add(dependency);
    external.add(`${dependency}/*`);
  }
}

rmSync(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: [join(root, 'packages', 'server', 'src', 'main.ts')],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  external: [...external],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

const files = Object.keys(result.metafile.outputs);
const bytes = Object.values(result.metafile.outputs).reduce((sum, file) => sum + file.bytes, 0);
console.log(
  `Built ${String(files.length)} files, ${String(Math.round(bytes / 1024))} KB, in dist/server.`,
);
