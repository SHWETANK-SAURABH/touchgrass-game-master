# Production image for the TouchGrass web app (Render target).
#
# The model runtime is NOT part of this image. Inference lives behind
# MODEL_BASE_URL on separate GPU hardware, which is what keeps a CPU-sized app
# container and a GPU-sized model host independently scalable. See
# ARCHITECTURE.md → "Production architecture".

# --- deps: install once against the lockfile ------------------------------
FROM node:24-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/game-definitions/package.json ./packages/game-definitions/
COPY packages/game-engine/package.json ./packages/game-engine/
COPY packages/game-session/package.json ./packages/game-session/
COPY packages/session-store/package.json ./packages/session-store/
COPY packages/session-persistence/package.json ./packages/session-persistence/
COPY packages/realtime/package.json ./packages/realtime/
COPY packages/server/package.json ./packages/server/
COPY packages/safety/package.json ./packages/safety/
COPY packages/ai/package.json ./packages/ai/
RUN npm ci

# --- build: compile the Next.js standalone bundle -------------------------
FROM node:24-alpine AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runtime: standalone server only --------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
# /api/health reports model-provider reachability, so Render's health check
# observes the same signal the application depends on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
