# Multi-stage Next.js standalone image. Build is performed by GitHub Actions,
# not on the constrained production host.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build-only

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
WORKDIR /app

# The one-off historical importer uses Python's stdlib sqlite3 exporter.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
# Migration scripts use dynamic imports that Next.js standalone tracing cannot
# discover. Ship the migration runtime explicitly; GitHub Actions validates the
# final image on the native runner before production deployment.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:3000/api/auth/verify").then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "server.js"]
