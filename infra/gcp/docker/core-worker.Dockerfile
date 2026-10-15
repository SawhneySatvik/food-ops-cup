# core-worker on Cloud Run: the real long-running worker (outbox sweep, cron jobs), one instance, CPU always allocated.
# Build from the repo root: docker build -f infra/gcp/docker/core-worker.Dockerfile .
FROM node:24-slim AS build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter @munim/core-api... --filter @munim/core-worker...

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node infra/gcp/entries/core-worker.mjs services/core-worker/src/cloud-run-entry.mjs
USER node
EXPOSE 8080
CMD ["node", "services/core-worker/src/cloud-run-entry.mjs"]
