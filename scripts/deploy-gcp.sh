#!/usr/bin/env bash
# scripts/deploy-gcp.sh: builds the images with Cloud Build and deploys them to Cloud Run in asia-south1.
# Create-or-update only (`gcloud run deploy`), so re-running is safe. Needs the one-time setup in infra/gcp/README.md first.
#   scripts/deploy-gcp.sh --project <id> [--tag <tag>] [--only <svc,svc>] [--skip-build] [--dry-run]
#   PROJECT_ID=<id> is read when --project is absent. Services: intel, suppliers-sim, core-api, core-worker, web.
#   web also needs MUNIM_DEMO_TENANT_ID=<the Cobnut tenant id the seed printed>. --skip-build needs --tag <an existing tag>.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="asia-south1"
REPO="munim"
SQL_INSTANCE="munim-db"
ALL_SERVICES=(intel suppliers-sim core-api core-worker web)

project="${PROJECT_ID:-}"
tag=""
only=""
skip_build=0
dry_run=0

die() { echo "deploy-gcp: $*" >&2; exit 2; }
usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# Both `--flag value` and `--flag=value`; a value flag without a value is refused, an unknown flag is refused.
needs_value() { [ -n "${2:-}" ] && [[ "$2" != --* ]] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --project=*) project="${1#*=}"; needs_value --project "$project"; shift ;;
    --project)   needs_value --project "${2:-}"; project="$2"; shift 2 ;;
    --tag=*)     tag="${1#*=}"; needs_value --tag "$tag"; shift ;;
    --tag)       needs_value --tag "${2:-}"; tag="$2"; shift 2 ;;
    --only=*)    only="${1#*=}"; needs_value --only "$only"; shift ;;
    --only)      needs_value --only "${2:-}"; only="$2"; shift 2 ;;
    --skip-build) skip_build=1; shift ;;
    --dry-run)   dry_run=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) usage >&2; die "unknown argument '$1'" ;;
  esac
done

[ -n "$project" ] || die "no project: export PROJECT_ID=<id> or pass --project <id>"
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "'$project' is not a valid project id"
if [ -n "$tag" ]; then [[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "'$tag' is not a valid image tag"; fi
if [ "$skip_build" = 1 ] && [ -z "$tag" ]; then die "--skip-build needs --tag <an image tag that is already built>"; fi

selected=("${ALL_SERVICES[@]}")
if [ -n "$only" ]; then
  selected=()
  IFS=, read -r -a want <<<"$only"
  for w in "${want[@]}"; do
    case " ${ALL_SERVICES[*]} " in *" $w "*) selected+=("$w") ;; *) die "--only: unknown service '$w'" ;; esac
  done
fi
has() { local s; for s in "${selected[@]}"; do [ "$s" = "$1" ] && return 0; done; return 1; }

# Prints the command (dry run) or runs it. Nothing else in this script changes anything.
run() {
  if [ "$dry_run" = 1 ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
gc() { run gcloud --project "$project" "$@"; }
[ "$dry_run" = 1 ] || command -v gcloud >/dev/null || die "gcloud is not installed (or not on PATH)"

if [ -z "$tag" ]; then
  # Sortable, unique per build (a rollback names a tag), and honest about an uncommitted tree: Cloud Build uploads the working tree.
  dirty=""; [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] || dirty="-dirty"
  tag="$(date -u +%Y%m%d%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)$dirty"
fi
image() { echo "$REGION-docker.pkg.dev/$project/$REPO/$1:$tag"; }

# Cloud Run's deterministic URL is https://<service>-<project number>.<region>.run.app, so every service's URL is known
# before any of them exists (web bakes core-api's origin into its build; core-api and intel need each other's).
if [ "$dry_run" = 1 ]; then
  number="<PROJECT_NUMBER>"
else
  number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
  [ -n "$number" ] || die "could not read the project number of '$project'"
fi
url() { echo "https://munim-$1-$number.$REGION.run.app"; }
core_url="$(url core-api)"; sim_url="$(url suppliers-sim)"; intel_url="$(url intel)"; web_url="$(url web)"

# Both pool URLs name the same Cloud SQL instance through Cloud Run's built-in connection (a unix socket; Cloud SQL has no
# pooler). No credentials in it: each role logs in as itself with MUNIM_DB_PASSWORD_<ROLE>.
db_url="postgres://localhost/munim?host=/cloudsql/$project:$REGION:$SQL_INSTANCE"
bucket="$project-munim-blobs"
sa() { echo "munim-$1@$project.iam.gserviceaccount.com"; }
common=(--region "$REGION" --platform managed)

# web is the one service with inputs that exist only after the first deploy of the others (the seed makes both).
storefront_key=""; demo_tenant="${MUNIM_DEMO_TENANT_ID:-}"
if has web; then
  if [ "$dry_run" = 1 ]; then
    storefront_key="<STOREFRONT_KEY>"; demo_tenant="${demo_tenant:-<MUNIM_DEMO_TENANT_ID>}"
  else
    [[ "$demo_tenant" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
      || die "web needs MUNIM_DEMO_TENANT_ID=<the Cobnut tenant id the seed printed> (see infra/gcp/README.md, deploy step 6)"
    if [ "$skip_build" = 0 ]; then
      # Public by design (it ships to browsers), but read from Secret Manager rather than typed into a shell.
      storefront_key="$(gcloud --project "$project" secrets versions access latest --secret=munim-storefront-key)"
      case "$storefront_key" in ""|*,*) die "secret munim-storefront-key is empty or holds a comma" ;; esac
    fi
  fi
fi

build() { # build <service>
  local svc="$1"
  local args=(builds submit "$ROOT" --region "$REGION" --ignore-file "$ROOT/infra/gcp/gcloudignore"
    --service-account "projects/$project/serviceAccounts/$(sa build)" --gcs-source-staging-dir "gs://$project-munim-build/source")
  if [ "$svc" = web ]; then
    gc "${args[@]}" --config "$ROOT/infra/gcp/cloudbuild-web.yaml" \
      --substitutions "_IMAGE=$(image web),_MUNIM_API_ORIGIN=$core_url,_STOREFRONT_KEY=$storefront_key"
  else
    gc "${args[@]}" --config "$ROOT/infra/gcp/cloudbuild.yaml" \
      --substitutions "_IMAGE=$(image "$svc"),_DOCKERFILE=infra/gcp/docker/$svc.Dockerfile"
  fi
}

# Every deploy below uses --set-env-vars / --set-secrets, which replace the whole list, so a re-run converges on this text.
# Names are in infra/gcp/README.md (one table). A secret is mounted `:latest`; a new version reaches a new instance only,
# so rotating means a new version and then a redeploy.

# intel: no database, no storage. Reached by core-api and core-worker with the service secret and a run token; /health is open.
deploy_intel() {
  gc run deploy munim-intel --image "$(image intel)" "${common[@]}" --service-account "$(sa intel)" \
    --ingress=all --allow-unauthenticated \
    --cpu=1 --memory=1Gi --cpu-boost --min-instances=0 --max-instances=3 --concurrency=20 --timeout=300 \
    --set-env-vars "MUNIM_MODEL_MODE=live,MUNIM_CORE_URL=$core_url,SUPPLIERS_SIM_PUBLIC_URL=$sim_url" \
    --set-secrets "MUNIM_SERVICE_SECRET=munim-service-secret:latest,MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM=munim-run-token-public-key:latest,GEMINI_API_KEY=munim-gemini-api-key:latest"
}

# suppliers-sim: three SIMULATED suppliers. No model, no secret, no database.
deploy_sim() {
  gc run deploy munim-suppliers-sim --image "$(image suppliers-sim)" "${common[@]}" --service-account "$(sa sim)" \
    --ingress=all --allow-unauthenticated \
    --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 --concurrency=40 --timeout=60 \
    --set-env-vars "SUPPLIERS_SIM_PUBLIC_URL=$sim_url"
}

# core-api: min 1 and CPU always allocated (a throttled instance stalls the LISTEN connection behind /v1/stream).
# Request timeout 3600 s (Cloud Run's cap) with streams ended at 3300 s so the client reconnects before the cut.
# One instance, MUNIM_DB_POOL_MAX=3: the connection arithmetic is in infra/gcp/README.md.
# MUNIM_TRUSTED_PROXY_HOPS is left unset (0: the rate limiters key on the socket address) until measured (infra/gcp/README.md,
# deploy step 8). Once measured, add it to the --set-env-vars list below: that list replaces the environment on every deploy.
deploy_core_api() {
  gc run deploy munim-core-api --image "$(image core-api)" "${common[@]}" --service-account "$(sa core-api)" \
    --set-cloudsql-instances "$project:$REGION:$SQL_INSTANCE" \
    --ingress=all --allow-unauthenticated \
    --cpu=1 --memory=512Mi --no-cpu-throttling --min-instances=1 --max-instances=1 --concurrency=200 --timeout=3600 \
    --set-env-vars "MUNIM_IDP=identity-platform,MUNIM_IDP_PROJECT_ID=$project,MUNIM_BLOB=gcs,MUNIM_BLOB_BUCKET=$bucket,MUNIM_INTEL_URL=$intel_url,MUNIM_DB_URL_SESSION=$db_url,MUNIM_DB_URL_TRANSACTION=$db_url,MUNIM_STREAM_MAX_AGE_S=3300,MUNIM_DB_POOL_MAX=3" \
    --set-secrets "MUNIM_DB_PASSWORD_MUNIM_CORE=munim-db-password-munim-core:latest,MUNIM_DB_PASSWORD_MUNIM_SVC=munim-db-password-munim-svc:latest,MUNIM_DB_PASSWORD_MUNIM_PLATFORM=munim-db-password-munim-platform:latest,MUNIM_SERVICE_SECRET=munim-service-secret:latest,MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM=munim-run-token-private-key:latest,MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM=munim-run-token-public-key:latest"
}

# core-worker: the real long-running worker as an always-on service, exactly one instance (two run each cron job twice).
# Nothing calls it, so ingress is internal and IAM stays closed; the entry's listener only answers Cloud Run's health check.
# It logs in as munim_svc only, so it gets no core or platform password. Its pools are fixed in code (MUNIM_DB_POOL_MAX is not read).
deploy_core_worker() {
  gc run deploy munim-core-worker --image "$(image core-worker)" "${common[@]}" --service-account "$(sa core-worker)" \
    --set-cloudsql-instances "$project:$REGION:$SQL_INSTANCE" \
    --ingress=internal --no-allow-unauthenticated \
    --cpu=1 --memory=512Mi --no-cpu-throttling --min-instances=1 --max-instances=1 \
    --set-env-vars "MUNIM_BLOB=gcs,MUNIM_BLOB_BUCKET=$bucket,MUNIM_INTEL_URL=$intel_url,MUNIM_DB_URL_TRANSACTION=$db_url" \
    --set-secrets "MUNIM_DB_PASSWORD_MUNIM_SVC=munim-db-password-munim-svc:latest,MUNIM_SERVICE_SECRET=munim-service-secret:latest,MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM=munim-run-token-private-key:latest,MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM=munim-run-token-public-key:latest"
}

# web: the only entry people open. Its /api rewrite (core-api's origin, fixed at build time) carries the SSE stream, so it
# gets the same 3600 s request timeout. The demo sign-in runs server-side here with the one demo password.
deploy_web() {
  gc run deploy munim-web --image "$(image web)" "${common[@]}" --service-account "$(sa web)" \
    --ingress=all --allow-unauthenticated \
    --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 --concurrency=80 --timeout=3600 \
    --set-env-vars "MUNIM_IDP=identity-platform,MUNIM_IDP_PROJECT_ID=$project,MUNIM_DEMO_SIGNIN=1,MUNIM_DEMO_TENANT_ID=$demo_tenant" \
    --set-secrets "MUNIM_IDP_WEB_API_KEY=munim-idp-web-api-key:latest,MUNIM_DEMO_PASSWORD=munim-demo-password:latest"
}

echo "deploy-gcp: project=$project region=$REGION tag=$tag services=${selected[*]}$([ "$dry_run" = 1 ] && echo ' (dry run: nothing is executed)')" >&2
if [ "$skip_build" = 0 ]; then
  for s in "${selected[@]}"; do build "$s"; done
fi
has intel && deploy_intel
has suppliers-sim && deploy_sim
has core-api && deploy_core_api
has core-worker && deploy_core_worker
has web && deploy_web
echo "deploy-gcp: done$([ "$dry_run" = 1 ] && echo ' (dry run: nothing was executed)'). web: $web_url" >&2
