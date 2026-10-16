# infra/gcp — Munim on Google Cloud (the Cup deploy)

Five Cloud Run services in `asia-south1` (Mumbai), one Cloud SQL Postgres, two Cloud Storage buckets, Identity Platform for
sign-in, Secret Manager for every secret. Built by Cloud Build, deployed by `scripts/deploy-gcp.sh` (`make deploy-gcp`).

Everything here is **synthetic data, simulated suppliers, recorded payments** (hard rule 5). `munim-suppliers-sim` answers
`/health` with the label "Simulated supplier"; no real supplier, customer or money is involved. Gemini runs **live** on the
free tier under the in-product spend cap (R56 G-4, R47); every test and gate stays recorded.

**State on 15 Oct (read this first).**
- Nothing here has run against a real project: no `gcloud` command in this file has been executed, and Docker was not
  available when it was written. Every claim about Google Cloud behaviour is `UNVERIFIED` until the first deploy (T-124).
- The services read the neutral names in the table below (T-122): core-api and core-worker choose the IdP and the blob
  store by `MUNIM_IDP` / `MUNIM_BLOB`, each runtime role logs in as itself on `MUNIM_DB_URL_*`, and the three database CLIs
  read `MUNIM_DB_URL_SESSION`. An unset `MUNIM_IDP` is refused at boot.
- Without Docker, each service's build context was reproduced by a script that applies its `.dockerignore` rules, then
  installed (locked), built and started on Node 22 locally (the images use Node 24): web answered 200 on `/` and
  `/staff/sign-in`; intel answered `/health` 200 and 401 without the service secret; suppliers-sim answered `/health` 200;
  core-api listened on `$PORT` and answered `/health` 503 with no database and `/v1/me` 401. That checks the file lists and the
  locked installs, not the Dockerfiles themselves.

## What is in this folder

| Path | What |
|---|---|
| `docker/<service>.Dockerfile` | One image per service, built from the repo root. Each has its own `<name>.Dockerfile.dockerignore`, an allowlist, so `.env`, `.run/` and keys never enter a build. |
| `entries/core-api.mjs`, `entries/core-worker.mjs` | Cloud Run entries, copied into the image as `cloud-run-entry.mjs`. The services' own entries bind `127.0.0.1` and read `.env` and `.run/`; these read the process environment only and listen on `$PORT`. |
| `cloudbuild.yaml`, `cloudbuild-web.yaml` | Build one image and push it to Artifact Registry. web is separate because Next fixes the core-api origin and the storefront key at build time. |
| `gcloudignore` | What `gcloud builds submit` uploads: secrets and local state never, and no folder an image does not read. |
| `../../scripts/deploy-gcp.sh` | Builds and deploys. Create-or-update, flags as `--x v` or `--x=v`, `--dry-run` prints every command and runs none. |

## The services

| Cloud Run service | Image | Runs as | Ingress | Instances | CPU / memory | Request timeout | Notes |
|---|---|---|---|---|---|---|---|
| `munim-web` | Next standalone | `munim-web` | all, public | 0–2 | 1 / 512Mi | 3600 s | Only entry people open. Its `/api` rewrite carries SSE to core-api. |
| `munim-core-api` | Node 24 | `munim-core-api` | all, public | **1–1** | 1 / 512Mi, **CPU always allocated** | 3600 s | Gotcha 8: a throttled instance stalls the LISTEN connection behind `/v1/stream`. Streams end at 3300 s (`MUNIM_STREAM_MAX_AGE_S`), under Cloud Run's 3600 s cap. |
| `munim-core-worker` | Node 24 | `munim-core-worker` | internal, no public access | **1–1** | 1 / 512Mi, **CPU always allocated** | default | The real long-running worker: outbox sweep and cron jobs. Exactly one instance: two would run each job twice. |
| `munim-intel` | Python 3.12, ADK | `munim-intel` | all | 0–3 | 1 / 1Gi, startup boost | 300 s | No database. Every route but `/health` needs the service secret; most also need a run token core minted. |
| `munim-suppliers-sim` | Python 3.12 | `munim-sim` | all | 0–2 | 1 / 512Mi | 60 s | Three **simulated** suppliers over A2A. Holds no secret and no data. |

Why intel and suppliers-sim are not internal-only: another Cloud Run service reaches an internal-only one only through a
VPC (Direct VPC egress), and with all egress on the VPC the callers also lose their direct route to Gemini and Identity
Platform unless Private Google Access or NAT is set up. That is a VPC, a private-IP database and several settings, all
unverified, for no code-level gain: intel already checks the service secret on every call (and the run token on most).
This follows `03-architecture.md` §8: public IP with Cloud Run's built-in Cloud SQL connection, no VPC. The first draft of
this folder used a VPC and was changed for that reason.

## One-time setup (the founder runs this)

Commands work in zsh and bash. Nothing below prints a secret; values go from a pipe straight into Secret Manager.
Replace the three placeholders in the first block.

```bash
export PROJECT_ID=your-project-id            # 6-30 characters: lowercase letters, digits, hyphens
export BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX  # gcloud billing accounts list
export REGION=asia-south1
gcloud config set project "$PROJECT_ID"
gcloud auth login                            # you, once. Nothing else in this repo handles credentials.

# one helper for every secret: the value comes in on stdin and stays in Mumbai
mk() { gcloud secrets create "$1" --replication-policy=user-managed --locations="$REGION" --data-file=-; }
# one helper for the IAM lines below
sa() { echo "serviceAccount:munim-$1@$PROJECT_ID.iam.gserviceaccount.com"; }
```

### 1. Project, billing, APIs

```bash
gcloud projects create "$PROJECT_ID" --name="Munim"            # skip if it exists
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com secretmanager.googleapis.com storage.googleapis.com identitytoolkit.googleapis.com \
  generativelanguage.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com \
  apikeys.googleapis.com billingbudgets.googleapis.com
```

### 2. Budget alert — before anything that costs money

The amount is the founder's. `FOUNDER_AMOUNT` is a number plus the billing account's currency, for example `5000INR`.

```bash
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" --display-name="munim-cup" \
  --budget-amount=FOUNDER_AMOUNT --filter-projects="projects/$PROJECT_ID" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

A budget **emails** billing admins; it does not stop spending. The hard stop is
`gcloud billing projects unlink "$PROJECT_ID"` (everything stops serving). Cost notes are at the end.

### 3. Artifact Registry and the two buckets

```bash
gcloud artifacts repositories create munim --repository-format=docker --location="$REGION" --description="Munim images"
gcloud storage buckets create "gs://$PROJECT_ID-munim-build" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets create "gs://$PROJECT_ID-munim-blobs" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
```

`-munim-build` holds the source Cloud Build uploads; `-munim-blobs` holds uploaded documents (the BlobStore, T-120). Neither
can be made public (`--public-access-prevention`).

### 4. Service accounts, least privilege

One account per service, plus the build and the demo-account job. Nothing gets a project-wide role except the two
that must (logging, Cloud SQL); the seed account's Identity Platform role is granted only while a job needs it.

```bash
for n in build core-api core-worker intel sim web seed; do
  gcloud iam service-accounts create "munim-$n" --display-name="munim $n"
done

# build: push images, write build logs, read the uploaded source
gcloud artifacts repositories add-iam-policy-binding munim --location="$REGION" --member="$(sa build)" --role=roles/artifactregistry.writer
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$(sa build)" --role=roles/logging.logWriter --condition=None
gcloud storage buckets add-iam-policy-binding "gs://$PROJECT_ID-munim-build" --member="$(sa build)" --role=roles/storage.objectViewer

# Cloud SQL: only the two services that talk to the database
for n in core-api core-worker; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$(sa $n)" --role=roles/cloudsql.client --condition=None
done

# blobs: core-api writes and reads, core-worker only reads
gcloud storage buckets add-iam-policy-binding "gs://$PROJECT_ID-munim-blobs" --member="$(sa core-api)" --role=roles/storage.objectAdmin
gcloud storage buckets add-iam-policy-binding "gs://$PROJECT_ID-munim-blobs" --member="$(sa core-worker)" --role=roles/storage.objectViewer

# demo accounts: NOT granted up front. Deploy step 4 creates the users as you, from your laptop. Only if you run
# adapters/gcp/idp-identity-platform/demo-accounts.ts as a Cloud Run job instead, grant this for that run and remove it
# right after (it can create, change and delete every user in the project):
#   gcloud projects add-iam-policy-binding    "$PROJECT_ID" --member="$(sa seed)" --role=roles/firebaseauth.admin --condition=None
#   gcloud projects remove-iam-policy-binding "$PROJECT_ID" --member="$(sa seed)" --role=roles/firebaseauth.admin --condition=None
```

Secret access is granted per secret in setup step 6. intel and suppliers-sim get no database and no storage role.
core-api keeps `roles/storage.objectAdmin` on the blobs bucket: uploads are content-addressed, so a repeat upload rewrites
the same object, which `objectCreator` refuses without a create-only precondition in the GCS adapter (not made yet).

### 5. Cloud SQL Postgres — `--edition=ENTERPRISE` (gotcha 7), `db-g1-small`

Without `--edition=ENTERPRISE`, Postgres 16+ defaults to Enterprise Plus, which is far dearer and has no small tier.

```bash
openssl rand -hex 24 | mk munim-db-admin-password          # the `postgres` password; only you read it
gcloud sql instances create munim-db --region="$REGION" --database-version=POSTGRES_17 \
  --edition=ENTERPRISE --tier=db-g1-small --storage-type=SSD --storage-size=10 --availability-type=zonal \
  --backup-start-time=21:00 --ssl-mode=ENCRYPTED_ONLY \
  --root-password="$(gcloud secrets versions access latest --secret=munim-db-admin-password)"
gcloud sql databases create munim --instance=munim-db
```

The instance has a public IP and **no authorised networks**, so nothing can reach it except Cloud Run's built-in connection
and Cloud SQL's auth proxy, both IAM-gated; `--ssl-mode=ENCRYPTED_ONLY` refuses any unencrypted connection (both connectors
encrypt their own leg, so neither is affected; `UNVERIFIED` until the first deploy). Postgres 17 is the version the
migrations were measured on; they use nothing newer than 15 (`db/README.md`, hosted-items list, item 6). `--backup-start-time` is UTC (21:00 is 02:30 IST).

**Why `db-g1-small` — the connection arithmetic (gotcha 24).** Worst case, from the code:

| Holder | Connections | Where it comes from |
|---|---|---|
| core-api, one instance, `MUNIM_DB_POOL_MAX=3` | core 3 + svc 3 + platform 2 + 1 LISTEN = **9** | `composeCoreApi` in `services/core-api/src/server.ts`: pools of 10, 5 and 2 each capped by `MUNIM_DB_POOL_MAX`, plus the LISTEN client |
| core-worker, one instance | its own pool 4 + the publisher/minter pool 2 = **6** | `Worker` (`max: 4`) in `services/core-worker/src/worker.ts`; `composeWorker` (`createPool(…, 2)`) in `main.ts` |
| you, running migrations, roles, packs through the proxy | **1** | one `pg.Client` at a time |
| intel, suppliers-sim, web | **0** | intel has no database client (import-linter); the other two never connect |

| Moment | Total | `db-f1-micro` (25, reserved slots included) | `db-g1-small` (50) |
|---|---|---|---|
| Steady state | 9 + 6 + 1 = **16** | fits | fits |
| core-api rollout (old and new revision together) | 9 + 9 + 6 + 1 = **25** | **does not fit** (3 are reserved for the superuser, a few more for Cloud SQL itself) | fits |
| core-worker rollout | 9 + 6 + 6 + 1 = **22** | no headroom (22 plus the reserved 3 is 25) | fits |
| Both rolling at once | **31** | does not fit | fits, 19 spare |

Cloud Run starts the new revision before the old one drains, and `--max-instances` applies per revision, so the service
being deployed briefly doubles. The pools are lazy (core-api's idle after 30 s, the worker's after 10 s), so real peaks sit
below this, but the budget uses the worst case. `db-g1-small` is the smallest tier that fits every row. The 25 and 50 are
the figures in `03-architecture.md` §8; after creating the instance run `SHOW max_connections;` and compare.

Known risk, tied to T-117: during a core-worker rollout two workers overlap for a few seconds, so a cron job can run
twice. The outbox sweep is guarded by an advisory lock; the brief and the fan-out are not until T-117's tick ledger lands.

### 6. Secrets

Create each secret once. The names are exactly the ones `scripts/deploy-gcp.sh` mounts.

```bash
openssl rand -hex 32 | mk munim-service-secret             # core <-> intel shared secret

d=$(mktemp -d)                                              # run-token signing pair (core signs, intel verifies)
openssl genpkey -algorithm ed25519 -out "$d/k.pem" && openssl pkey -in "$d/k.pem" -pubout -out "$d/k.pub.pem"
mk munim-run-token-private-key < "$d/k.pem"
mk munim-run-token-public-key  < "$d/k.pub.pem"
rm -rf "$d"

printf 'Gemini API key: '; read -rs K; echo; printf %s "$K" | mk munim-gemini-api-key; unset K
```

**Gemini key.** R56: the free tier, with a key you create. Whether a key made in a project that has billing linked stays on
the free tier is `UNVERIFIED` — check the key's tier in Google AI Studio before the first live call. The in-product AI
spend cap (R47) is the second limit; the budget alert in setup step 2 is the third.

**Identity Platform and its web API key.**
1. Console, Identity Platform: click Enable. Providers: add Email/Password and turn it on.
2. After `munim-web` exists (deploy step 7 below): Settings, Authorized domains, add the `munim-web-<project number>.asia-south1.run.app` host.
3. The API key for the server-side demo sign-in (public by design; restricted to the one API):

```bash
gcloud services api-keys create --display-name=munim-idp-web --api-target=service=identitytoolkit.googleapis.com
KEY=$(gcloud services api-keys list --filter='displayName=munim-idp-web' --format='value(name)')
gcloud services api-keys get-key-string "$KEY" --format='value(keyString)' | tr -d '\n' | mk munim-idp-web-api-key
```

**Three more secrets come later** (they do not exist yet): `munim-db-password-munim-core`, `-munim-svc`, `-munim-platform`
after deploy step 2; `munim-storefront-key` and `munim-demo-password` after the seed (deploy step 6).

**Per-secret access.** Run this after the later secrets exist (or re-run it; it is idempotent):

```bash
grant() { local who="$1"; shift; for s in "$@"; do
  gcloud secrets add-iam-policy-binding "$s" --member="$(sa "$who")" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null; done; }
grant core-api    munim-db-password-munim-core munim-db-password-munim-svc munim-db-password-munim-platform \
                  munim-service-secret munim-run-token-private-key munim-run-token-public-key
grant core-worker munim-db-password-munim-svc munim-service-secret munim-run-token-private-key munim-run-token-public-key
grant intel       munim-service-secret munim-run-token-public-key munim-gemini-api-key
grant web         munim-idp-web-api-key munim-demo-password
grant seed        munim-idp-web-api-key
```

`munim-db-admin-password` and `munim-storefront-key` have no service reader: the first is yours, the second is read by the
deploy script as you.

## Environment names — one table

Every name the five services read on Cloud Run. Plain values are set by `scripts/deploy-gcp.sh`; secrets are mounted from
Secret Manager `:latest`.

| Name | Service(s) | Kind | Source |
|---|---|---|---|
| `MUNIM_DB_URL_SESSION` | core-api | plain | `postgres://localhost/munim?host=/cloudsql/<project>:asia-south1:munim-db` (script) |
| `MUNIM_DB_URL_TRANSACTION` | core-api, core-worker | plain | same value (Cloud SQL has no pooler, so session and transaction are one) |
| `MUNIM_DB_PASSWORD_MUNIM_CORE` | core-api | secret `munim-db-password-munim-core` | `bootstrap-roles` output |
| `MUNIM_DB_PASSWORD_MUNIM_SVC` | core-api, core-worker | secret `munim-db-password-munim-svc` | same |
| `MUNIM_DB_PASSWORD_MUNIM_PLATFORM` | core-api | secret `munim-db-password-munim-platform` | same |
| `MUNIM_SERVICE_SECRET` | core-api, core-worker, intel | secret `munim-service-secret` | `openssl rand` |
| `MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM` | core-api, core-worker | secret `munim-run-token-private-key` | `openssl genpkey` |
| `MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM` | core-api, core-worker, intel | secret `munim-run-token-public-key` | same pair |
| `MUNIM_IDP` | core-api, web | plain `identity-platform` | script |
| `MUNIM_IDP_PROJECT_ID` | core-api, web | plain | script (`$PROJECT_ID`) |
| `MUNIM_IDP_WEB_API_KEY` | web | secret `munim-idp-web-api-key` | API key, setup step 6 |
| `MUNIM_BLOB` | core-api, core-worker | plain `gcs` | script |
| `MUNIM_BLOB_BUCKET` | core-api, core-worker | plain `<project>-munim-blobs` | script |
| `MUNIM_INTEL_URL` | core-api, core-worker | plain | script (intel's deterministic URL) |
| `MUNIM_STREAM_MAX_AGE_S` | core-api | plain `3300` | script |
| `MUNIM_DB_POOL_MAX` | core-api | plain `3` | script; the worker does not read it (its pools are fixed) |
| `MUNIM_MODEL_MODE` | intel | plain `live` | script |
| `GEMINI_API_KEY` | intel | secret `munim-gemini-api-key` | your key |
| `MUNIM_CORE_URL` | intel | plain | script (core-api's deterministic URL) |
| `SUPPLIERS_SIM_PUBLIC_URL` | intel, suppliers-sim | plain | script (the sim's deterministic URL; its cards advertise it) |
| `MUNIM_DEMO_SIGNIN` | web | plain `1` | script |
| `MUNIM_DEMO_TENANT_ID` | web | plain | the tenant id the seed prints (`MUNIM_DEMO_TENANT_ID=… scripts/deploy-gcp.sh --only web`) |
| `MUNIM_DEMO_PASSWORD` | web | secret `munim-demo-password` | the demo accounts' one password |

**Build-time only (web image):** `MUNIM_API_ORIGIN` (core-api's URL, from the script), `NEXT_PUBLIC_MUNIM_STOREFRONT_KEY`
(secret `munim-storefront-key`, read by the script as you; public by design), `NEXT_PUBLIC_MUNIM_API=/api` and
`MUNIM_NEXT_STANDALONE=1` (set in `web.Dockerfile`). **Set by Cloud Run or the Dockerfiles:** `PORT`, `NODE_ENV=production`,
`HOSTNAME`, `SUPPLIERS_SIM_HOST`.

**Deliberately unset:**
- `MUNIM_TRUSTED_PROXY_HOPS` (0: the rate limiters key on the socket address): no hop count has been measured, and a
  guessed one can make the limiters' key a value the client types. Measure it after the first deploy (deploy step 8), then
  add it to `deploy_core_api`'s `--set-env-vars` in `scripts/deploy-gcp.sh` (that list replaces the whole environment on
  every deploy, so a `gcloud run services update` alone is lost on the next one).
- `MUNIM_CORS_ORIGINS`: the browser is same-origin through web's `/api` rewrite.
- `MUNIM_CRON_SECRET` and `MUNIM_TICK_*`: no tick route; core-worker runs the jobs.
- `MUNIM_RUN_DIR` and any local-database URL: dev only.

**How the code reads them.** `packages/config` reads the database, IdP and blob names; `MUNIM_DB_URL_*` are base URLs
(host and database; Cloud SQL has no pooler, so both are the same socket URL) and each runtime role logs in as itself with
`MUNIM_DB_PASSWORD_<ROLE>`. core-api's `idpFromConfig` and `blobStoreFromEnv` turn `MUNIM_IDP=identity-platform` and
`MUNIM_BLOB=gcs` into the adapters in `adapters/gcp`; `entries/core-worker.mjs` imports `blobStoreFromEnv` from
`env-root.ts`, so both processes use the same store. web's demo sign-in (`apps/web/lib/server/demo-session.ts`) runs
Identity Platform's password grant with `MUNIM_IDP_WEB_API_KEY`.

## Deploy order

Run from the repo root, after the one-time setup. `pnpm install` once first (the database scripts use the repo's `pg`).

### 1. Database: migrations, roles, packs (from your laptop, through the auth proxy)

```bash
brew install cloud-sql-proxy                 # once; or Google's installer
gcloud auth application-default login        # once; the proxy uses it
cloud-sql-proxy --port 5433 "$PROJECT_ID:$REGION:munim-db" &
export MUNIM_DB_URL_SESSION="postgres://postgres:$(gcloud secrets versions access latest --secret=munim-db-admin-password)@127.0.0.1:5433/munim"

# pgvector is not a trusted extension: install it once as the admin (migration 0013 expects it)
node -e 'const {Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.MUNIM_DB_URL_SESSION});await c.connect();await c.query("CREATE EXTENSION IF NOT EXISTS vector");await c.end();console.log("vector: ok")})()'

node db/migrate.ts                           # every migration, 0001 to the latest
node db/scripts/bootstrap-roles.ts           # fresh random passwords for the login roles -> .run/db-roles.json (git-ignored, 0600)
node db/seeds/packs.ts                       # the country packs
```

(`db/migrate.ts`, `bootstrap-roles.ts` and `packs.ts` read `MUNIM_DB_URL_SESSION` from the environment only.)

### 2. Put the role passwords in Secret Manager, then delete the file

```bash
for r in munim_core munim_svc munim_platform; do
  node -e 'process.stdout.write(require(process.argv[1]).roles[process.argv[2]])' "$PWD/.run/db-roles.json" "$r" | mk "munim-db-password-${r//_/-}"
done
rm .run/db-roles.json
```

Run the `grant …` lines from setup step 6 now. **Running `bootstrap-roles` again rotates every password**: add a new version of
each of the three secrets (`… | gcloud secrets versions add munim-db-password-munim-core --data-file=-`) and redeploy
core-api and core-worker, or they cannot log in.

### 3. The four services that do not need the seed

```bash
scripts/deploy-gcp.sh --project "$PROJECT_ID" --dry-run --only intel,suppliers-sim,core-api,core-worker   # read the plan first
scripts/deploy-gcp.sh --project "$PROJECT_ID" --only intel,suppliers-sim,core-api,core-worker
# same thing through make:   make deploy-gcp PROJECT_ID="$PROJECT_ID" DEPLOY_ARGS="--only intel,suppliers-sim,core-api,core-worker"
```

The script builds each image with Cloud Build (a few minutes each, intel the longest), then deploys. URLs are known in
advance (`https://munim-<service>-<project number>.asia-south1.run.app`), which is how core-api and intel can point at each
other before either exists. Check: `curl -s "$(gcloud run services describe munim-core-api --region $REGION --format='value(status.url)')/health"`
returns 200 with the migration version.

### 4. Seed Cobnut as a demo business, with the synthetic seed operator (R64 X-1)

The seed runs from your laptop through core-api's public `/v1` API with five sign-ins: the four demo people and the
**synthetic seed operator**, the same one every other hosted seed uses (`worldgen-cobnut-operator`; not a person and not a
demo account). With an operator token worldgen provisions the tenant as a **demo business** (`is_demo`, so every staff screen
shows "Sample data", hard rule 5), prices the live AI roles at ₹0 and writes the ₹100 monthly AI budget (R59), each an
operator-approved config draft (R24). Without it the Cobnut seed refuses before writing anything. It makes a **fresh tenant
every run**, prints the tenant id, and writes `storefront-key` and `site.env` under `.run/cobnut/` (git-ignored, 0600).

Every account is made by you, with the same Identity Toolkit calls `adapters/gcp/idp-identity-platform/demo-accounts.ts` makes,
so no job runs and no token reaches Cloud Logging. Passwords stay in 0600 files and go to `curl` on stdin, never as an argument.
`UNVERIFIED` until the first run: the admin calls with your own credentials (they need the `X-Goog-User-Project` header), a
fixed `localId` on create, and Identity Platform accepting `*@cobnut-demo.invalid` and `*.synthetic.test` addresses.

```bash
NUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CORE="https://munim-core-api-$NUM.$REGION.run.app"; SIM="https://munim-suppliers-sim-$NUM.$REGION.run.app"   # as intel has them
IDT=https://identitytoolkit.googleapis.com/v1
WEBKEY=$(gcloud secrets versions access latest --secret=munim-idp-web-api-key)
mkdir -p -m 0700 .run/cobnut
(umask 077; for f in demo-password operator-password; do [ -s ".run/cobnut/$f" ] || openssl rand -hex 24 > ".run/cobnut/$f"; done)

admin() { curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "X-Goog-User-Project: $PROJECT_ID" -H 'content-type: application/json' --data @- "$IDT/projects/$PROJECT_ID/$1"; }
# put_user <uid> <email> <password file>: create the user, verified; on a re-run (400: it exists) set the same password again
put_user() {
  local body s; body=$(printf '{"localId":"%s","email":"%s","password":"%s","emailVerified":true}' "$1" "$2" "$(tr -d '\n' < "$3")")
  s=$(printf %s "$body" | admin accounts); [ "$s" = 400 ] && s=$(printf %s "$body" | admin accounts:update); echo "$2: HTTP $s"
}
# id_token <email> <password file>: the password grant web's demo sign-in makes; prints the ID token (valid 1 h), or fails
id_token() {
  printf '{"email":"%s","password":"%s","returnSecureToken":true}' "$1" "$(tr -d '\n' < "$2")" |
    curl -sS -H 'content-type: application/json' --data @- "$IDT/accounts:signInWithPassword?key=$WEBKEY" |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const t=JSON.parse(s||"{}").idToken;if(!t)process.exit(1);process.stdout.write(t)})'
}

for k in owner manager counter kitchen; do put_user "cobnut-demo-$k" "$k@cobnut-demo.invalid" .run/cobnut/demo-password; done
put_user worldgen-cobnut-operator operator@cobnut.synthetic.test .run/cobnut/operator-password      # each line: HTTP 200

# The operator's platform.operator row. No route creates operators, so this is the one SQL step: as the admin login, through
# the proxy and MUNIM_DB_URL_SESSION from deploy step 1, with the id worldgen's own test stack gives it (tools/worldgen/src/ids.ts).
node --input-type=module -e '
import pg from "pg"; import { idOf } from "./tools/worldgen/src/ids.ts";
const c = new pg.Client({ connectionString: process.env.MUNIM_DB_URL_SESSION }); await c.connect();
const r = await c.query("INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, $3) ON CONFLICT (idp_sub) DO NOTHING",
  [idOf("gcp", "cobnut", "operator"), "worldgen-cobnut-operator", "operator@cobnut.synthetic.test"]);
await c.end(); console.log(`platform.operator: ${r.rowCount ? "added" : "already there"}`);'

(umask 077
 for k in owner manager counter kitchen; do id_token "$k@cobnut-demo.invalid" .run/cobnut/demo-password > ".run/cobnut/token-$k" || echo "FAIL: $k"; done
 id_token operator@cobnut.synthetic.test .run/cobnut/operator-password > .run/cobnut/operator-token || echo "FAIL: operator")
MUNIM_API_URL="$CORE" SUPPLIERS_SIM_PUBLIC_URL="$SIM" MUNIM_SEED_TOKENS="$(printf '{"owner":"%s","manager":"%s","counter":"%s","kitchen":"%s","operator":"%s"}' \
  "$(cat .run/cobnut/token-owner)" "$(cat .run/cobnut/token-manager)" "$(cat .run/cobnut/token-counter)" "$(cat .run/cobnut/token-kitchen)" \
  "$(cat .run/cobnut/operator-token)")" make seed WORLD=cobnut
rm -f .run/cobnut/token-*                       # keep operator-token for step 5 (OPERATOR_TOKEN=$(cat .run/cobnut/operator-token))
```

It prints `worldgen: cobnut seeded (…); tenant <id>` and `live AI roles priced at 0 INR (R59): …`; it exits 1, naming the gap,
if live AI could not be made ready. An ID token lasts an hour: for a later step 5, run the `id_token operator…` line again.

**Then close the doors behind the seed (R64 X-4):**
- **Self-serve sign-up off.** The demo needs no sign-up: the accounts above are made by an admin, and sign-in keeps working.
  Console: Identity Platform → Settings → User actions → clear "Enable create (sign-up)" → Save. Or (`UNVERIFIED` field name,
  from the Identity Toolkit admin v2 reference):

  ```bash
  printf '{"client":{"permissions":{"disabledUserSignup":true}}}' | curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "X-Goog-User-Project: $PROJECT_ID" -H 'content-type: application/json' \
    --data @- "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=client.permissions.disabledUserSignup"
  ```

  Check: a sign-up with the web key (`$IDT/accounts:signUp?key=…`) is refused (expected `ADMIN_ONLY_OPERATION`, `UNVERIFIED`),
  and the demo sign-in on web still works.
  core-api also caps how many tenants one sign-in can onboard through `/v1/onboarding`, in case sign-up is ever turned back on.
- **The seed account's Identity Platform role**, if you granted it for a job (setup step 4):
  `gcloud projects remove-iam-policy-binding "$PROJECT_ID" --member="$(sa seed)" --role=roles/firebaseauth.admin --condition=None`.

### 5. The reasoning role on gemini-3.5-flash-lite

The live demo's reasoning role (`reason`: the Ask Manager, its fan-out branches and the supplier negotiation's chooser) runs on
`gemini-3.5-flash-lite`, whose free-tier daily quota is larger than `gemini-3.8-flash`'s; at the default the Ask answers "Cannot
verify" once the 3.8 quota is spent. It is a platform setting, changed only through an operator's approved config draft, at 0 INR
per 1M tokens (the free-tier key bills nothing). Do it once, after the first seed (a reseed does not undo it). `OPERATOR_TOKEN` is
the synthetic seed operator's sign-in token (step 4), read in with `read -rs OPERATOR_TOKEN`, never typed as an argument.

```bash
CORE="$(gcloud run services describe munim-core-api --region "$REGION" --format='value(status.url)')"
# propose (core mints the draft id and answers with the draft), then approve it, then read the roles back
DRAFT=$(printf 'Authorization: Bearer %s\n' "$OPERATOR_TOKEN" | curl -sf -X POST "$CORE/platform/v1/config-drafts" -H @- \
  -H 'content-type: application/json' -d '{"target":"model_role:reason","patch":{"provider":"gemini","model_id":"gemini-3.5-flash-lite","input_price_per_mtok_minor":0,"output_price_per_mtok_minor":0,"price_currency":"INR"}}' \
  | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).id))')
printf 'Authorization: Bearer %s\n' "$OPERATOR_TOKEN" | curl -sf -X POST "$CORE/platform/v1/config-drafts/$DRAFT:approve" -H @- -H 'content-type: application/json' -d '{}'
printf 'Authorization: Bearer %s\n' "$OPERATOR_TOKEN" | curl -s "$CORE/platform/v1/model-roles" -H @-   # reason: gemini-3.5-flash-lite, 0/0 INR
```

The approval answers with the draft `"status":"applied"`. The `router`, `narrate` and `extract` roles are already on flash-lite;
`vision` (invoice reading, not the Ask) stays on gemini-3.8-flash.

### 6. The two secrets the seed produces, then web

```bash
tr -d '\n' < .run/cobnut/storefront-key | mk munim-storefront-key                  # the key the seed printed a path for
tr -d '\n' < .run/cobnut/demo-password | mk munim-demo-password                  # the demo-accounts step wrote it there (0600)
export MUNIM_DEMO_TENANT_ID=<the tenant id the seed printed>
scripts/deploy-gcp.sh --project "$PROJECT_ID" --only web
```

If the demo accounts were made by a Cloud Run job there is no local password file: read it in with the `read -rs` pattern from setup step 6, never as an argument.
Run `grant web …` and `grant seed …` again if you have not. The script refuses to deploy web without a well-formed
`MUNIM_DEMO_TENANT_ID` (otherwise demo sign-in would answer 503).

### 7. Open the door and check

1. Add the web host to Identity Platform's authorised domains (setup step 6).
2. `https://munim-web-<project number>.asia-south1.run.app/` loads; the demo sign-in works; "Sample data" shows on every staff
   screen (the tenant is a demo business, step 4); "Simulated supplier" shows on the supplier screens.
3. Streaming: `curl -sN -H 'Authorization: Bearer …' -H 'X-Munim-Tenant: …' '<web URL>/api/v1/stream?topics=…'` shows `event: ready` at once, a `: hb` about every 20 s and `event: reconnect` near 3300 s. That proves web's rewrite streams without buffering (`UNVERIFIED`).
4. `…/internal/cron/v1/tick` on core-api answers 404 (the tick route is off).

### 8. Measure `MUNIM_TRUSTED_PROXY_HOPS` (until then it stays 0)

The rate limiters key a request on the `X-Forwarded-For` entry `N` from the right, `N = MUNIM_TRUSTED_PROXY_HOPS`; at 0, on the
socket address. `N` must count only proxies that **append** the address they saw. One too many and the key is an entry the client
typed, so a limiter can be dodged with a made-up header; one too few and everyone behind a proxy shares one bucket. Nothing has
been measured: how Cloud Run's front end and web's rewrite fill the header is `UNVERIFIED`. INFERENCE: core-api is public, so a
direct caller's header passes only Cloud Run's front end, and any `N` above 1 is spoofable by a direct caller.

The probe is the credential-free Cares route, 60 requests a minute per key, on core-api's single instance (so the count is exact).
Set a candidate `N` (add `MUNIM_TRUSTED_PROXY_HOPS=N` to `deploy_core_api`'s `--set-env-vars` and redeploy core-api), then:

```bash
WEB="https://munim-web-$NUM.$REGION.run.app"
probe() { for i in $(seq 1 61); do curl -s -o /dev/null -w '%{http_code}\n' -H "X-Forwarded-For: 198.51.100.$i" "$1"; done | sort | uniq -c; }
probe "$CORE/v1/cares-network/cities"       # direct: must end in one 429; 61 x 200 = the typed header became the key, N too high
sleep 61; probe "$WEB/api/v1/cares-network/cities"   # through web: the same rule
```

Then the sharing test through web: right after a 61-request run from one network, send one request from a second network (a phone
hotspot). 429 means both share a bucket (the key is a proxy's address); 200 means they do not. Keep the largest `N` whose two probes
still end in a 429. If that `N` still shares a bucket through web, the limiters count per web egress address, not per visitor:
record that in the deploy notes rather than raise `N`.

## Reseed Cobnut

Same as deploy steps 4 and 6 (step 5 is platform-wide and stays done): each seed is a new tenant with a new storefront key, and the books are append-only, so the old tenants
stay. Add a **new version** of `munim-storefront-key` (and of `munim-demo-password` if the accounts changed), then redeploy web
with the new tenant id: `MUNIM_DEMO_TENANT_ID=<new id> scripts/deploy-gcp.sh --project "$PROJECT_ID" --only web`. web is rebuilt
because the key is baked into its build.

## Rollback

Every build has a unique tag (`<UTC time>-<git sha>[-dirty]`), and Artifact Registry keeps them.

```bash
# what is running, and what tags exist
gcloud run revisions list --service munim-core-api --region "$REGION"
gcloud artifacts docker images list "$REGION-docker.pkg.dev/$PROJECT_ID/munim" --include-tags --format='table(package,tags,createTime)'

# fastest: shift traffic to an earlier revision (core-api, web, intel, suppliers-sim)
gcloud run services update-traffic munim-core-api --region "$REGION" --to-revisions REVISION_NAME=100
gcloud run services update-traffic munim-core-api --region "$REGION" --to-latest     # later: resume following new deploys

# any service, including core-worker (it takes no traffic): redeploy an earlier tag without rebuilding
scripts/deploy-gcp.sh --project "$PROJECT_ID" --only core-worker --skip-build --tag EARLIER_TAG
```

- **Database.** Migrations only go forward (rule 6): a bad migration is fixed with a new one, never edited. The data is
  append-only books, so there is no row-level undo either. The last resort is a Cloud SQL backup restore
  (`gcloud sql backups list --instance munim-db`, then `gcloud sql backups restore BACKUP_ID --restore-instance=munim-db`),
  which **overwrites** the instance and loses every write since that backup.
- **Secrets.** A new version reaches only new instances. After `gcloud secrets versions add …`, redeploy the service
  (`--skip-build --tag <the running tag>` is enough).

## Cost notes

All figures are `INFERENCE` from public list prices and `UNVERIFIED` for `asia-south1`; the budget alert is the measurement.
- **The two always-on services are the bill.** core-api and core-worker both run with CPU always allocated and one instance
  (gotcha 8: Cloud Run throttles CPU between requests and the LISTEN connection and the cron loop would stall). An
  always-on 1 vCPU / 512 Mi instance is on the order of tens of US dollars a month each, so a few days of the Cup window
  costs a few dollars, and a month would not be small. The Cloud SQL `db-g1-small` is on the order of $27 a month
  (`03-architecture.md` §8).
- **Min instances 1 only where needed:** core-api (SSE) and core-worker (cron). web, intel and suppliers-sim scale to zero
  and cost nothing idle; the price is a cold start of a few seconds. Warm them for judging and relax them after:

  ```bash
  gcloud run services update munim-web   --region "$REGION" --min-instances=1     # before judging
  gcloud run services update munim-intel --region "$REGION" --min-instances=1
  gcloud run services update munim-web   --region "$REGION" --min-instances=0     # after
  gcloud run services update munim-intel --region "$REGION" --min-instances=0
  ```
- **Parking after the event.** Scale the two always-on services down and stop the database; storage is still billed.
  A later `scripts/deploy-gcp.sh` puts min instances back to 1.

  ```bash
  gcloud run services update munim-core-api    --region "$REGION" --min-instances=0 --cpu-throttling
  gcloud run services update munim-core-worker --region "$REGION" --min-instances=0 --cpu-throttling
  gcloud sql instances patch munim-db --activation-policy=NEVER        # ALWAYS to start it again
  ```
- **SSE and the 60-minute cap.** Cloud Run ends any request at 3600 s. core-api ends each stream itself at 3300 s with a
  reconnect hint (`MUNIM_STREAM_MAX_AGE_S=3300`, the config default), and web's timeout is also 3600 s, so a client always
  sees the hint before the cut and reconnects.
- **Gemini** is free-tier and recorded-fallback (T-125) behind the in-product cap; Cloud Build and Artifact Registry are
  small at this size.

## First deploy: what is unverified

1. Every `gcloud` flag above is from the public CLI reference; none was run.
2. Cloud Run's deterministic URL form (`<service>-<project number>.<region>.run.app`), which the script relies on.
3. The unix-socket DB URL: the `pg` client was checked locally to read `?host=/cloudsql/…` as the socket path (and to keep a
   password containing `@` and `/` intact); Cloud Run's side of it was not.
4. Migrations on Cloud SQL's `postgres` user, which is not a true superuser: `ALTER ROLE … BYPASSRLS`, `GRANT munim_migrator
   TO CURRENT_USER`, `ALTER DEFAULT PRIVILEGES FOR ROLE munim_migrator`, `btree_gist`, `pgcrypto`, `vector`
   (`db/README.md`, hosted-items list, items 1 to 5 and 8). Each has a fallback listed there.
5. `roles/storage.objectViewer` is enough for core-worker's reads through the BlobStore adapter.
6. An organisation policy that forbids `allUsers` would block `--allow-unauthenticated`.
7. `SHOW max_connections;` on the new instance is at least 50.
8. The Gemini key stays on the free tier.
9. The `X-Forwarded-For` hop count (deploy step 8; `MUNIM_TRUSTED_PROXY_HOPS` stays 0 until then), and SSE through web's rewrite
   without buffering.
10. The images have not been built by Docker anywhere yet; the first Cloud Build is the first Docker build.
