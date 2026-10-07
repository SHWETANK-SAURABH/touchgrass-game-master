import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Internal packages are consumed as TypeScript source rather than built to
  // dist. One fewer build step, no watch-mode orchestration, and no stale
  // artefacts — at the cost of Next compiling them, which it already does for
  // app code. See ARCHITECTURE.md -> "Internal packages".
  transpilePackages: [
    '@touchgrass/ai',
    '@touchgrass/game-definitions',
    '@touchgrass/game-engine',
    '@touchgrass/safety',
    '@touchgrass/shared',
  ],

  // Required for the Docker image: the standalone server must trace files from
  // the monorepo root, not from apps/web. fileURLToPath rather than `.pathname`,
  // which yields "/C:/..." on Windows and fails path canonicalisation.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),

  typedRoutes: true,
};

export default nextConfig;
