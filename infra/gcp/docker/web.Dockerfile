# web (apps/web) on Cloud Run, Next standalone output. Build from the repo root:
#   docker build -f infra/gcp/docker/web.Dockerfile --build-arg MUNIM_API_ORIGIN=<core-api URL> --build-arg NEXT_PUBLIC_MUNIM_STOREFRONT_KEY=<key> .
# Next evaluates rewrites() and inlines NEXT_PUBLIC_* at build time, so these are build arguments, not runtime env.
FROM node:24-slim AS build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @munim/web...
ARG MUNIM_API_ORIGIN
ARG NEXT_PUBLIC_MUNIM_STOREFRONT_KEY
ARG NEXT_PUBLIC_MUNIM_API=/api
ENV MUNIM_API_ORIGIN=$MUNIM_API_ORIGIN NEXT_PUBLIC_MUNIM_API=$NEXT_PUBLIC_MUNIM_API \
    NEXT_PUBLIC_MUNIM_STOREFRONT_KEY=$NEXT_PUBLIC_MUNIM_STOREFRONT_KEY MUNIM_NEXT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN test -n "$MUNIM_API_ORIGIN" && cd apps/web && node_modules/.bin/next build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# apps/web has no public/ directory today; if one is added, copy it to ./apps/web/public here.
USER node
EXPOSE 8080
# PORT is set by Cloud Run; the standalone server reads it.
CMD ["node", "apps/web/server.js"]
