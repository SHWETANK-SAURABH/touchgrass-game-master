#!/usr/bin/env node
/**
 * Copies .env.example into the two places that actually read environment values:
 *
 *   ./.env                -> docker compose (local model runtime)
 *   apps/web/.env.local   -> Next.js (application runtime)
 *
 * Next.js only loads dotenv files from its own project directory, which is
 * apps/web in this monorepo. Rather than teach the app to reach up into the repo
 * root, we keep one tracked template and fan it out. Existing files are never
 * overwritten, so local secrets survive repeated runs.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(repoRoot, '.env.example');

if (!existsSync(template)) {
  console.error('[setup] .env.example is missing — cannot continue.');
  process.exit(1);
}

const targets = [join(repoRoot, '.env'), join(repoRoot, 'apps', 'web', '.env.local')];
let created = 0;

for (const target of targets) {
  const label = target.slice(repoRoot.length + 1);
  if (existsSync(target)) {
    console.log(`[setup] kept     ${label} (already exists)`);
    continue;
  }
  copyFileSync(template, target);
  console.log(`[setup] created  ${label}`);
  created += 1;
}

console.log(
  created > 0
    ? '[setup] done. Review the new files, then run: npm run ai:up && npm run ai:pull'
    : '[setup] nothing to do.',
);
