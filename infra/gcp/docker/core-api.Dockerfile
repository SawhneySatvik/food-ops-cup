# core-api on Cloud Run. Build from the repo root: docker build -f infra/gcp/docker/core-api.Dockerfile .
# (Cloud Build does this via infra/gcp/cloudbuild.yaml.) Node 24 strips TypeScript types at run time, as the repo does today.
# Dependencies come from the committed lockfile only (--frozen-lockfile never rewrites it, gotcha 27).
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
COPY --chown=node:node infra/gcp/entries/core-api.mjs services/core-api/src/cloud-run-entry.mjs
USER node
EXPOSE 8080
CMD ["node", "services/core-api/src/cloud-run-entry.mjs"]
