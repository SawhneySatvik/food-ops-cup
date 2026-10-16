# Deploy Munim on Google Cloud: a checklist

Follow this on a fresh Google Cloud project. Every command lives in [`infra/gcp/README.md`](./infra/gcp/README.md), the
runbook; each step below names the runbook section to run and says how to know it worked. This page adds the order, the
checks and the things people forget. It does not repeat the commands.

What you end up with: five Cloud Run services in `asia-south1` (`munim-web`, `munim-core-api`, `munim-core-worker`,
`munim-intel`, `munim-suppliers-sim`), one Cloud SQL for PostgreSQL instance, two private Cloud Storage buckets, Identity
Platform sign-in, Secret Manager for every secret, and a synthetic demo business, Cobnut Bakehouse. The demo is synthetic
data, simulated suppliers and recorded payments; it handles no real money or customer.

Read the runbook's "First deploy: what is unverified" list before you start. The commands come from Google's public CLI
reference. If one fails, fix it for your project and carry on; nothing here depends on an unusual setting.

## Before you start

- [ ] A Google Cloud account that can create a project and link a billing account. You pay for what runs; there are no credits.
- [ ] `gcloud` installed and signed in (`gcloud auth login`). The runbook uses your own credentials throughout.
- [ ] Node 22.18 or later, `pnpm` 11, `openssl`, `curl`, and Google's `cloud-sql-proxy`.
- [ ] A Gemini API key from Google AI Studio. Check the key's tier there before the first live call.
- [ ] A clean clone of this repository, then `pnpm install --frozen-lockfile` once at the root.
- [ ] A shell where you will keep `PROJECT_ID`, `REGION`, `BILLING_ACCOUNT` and `NUM` (the project number) exported. The runbook's first block sets the first three.

## The checklist

Do the steps in order. Do not skip step 2.

### One-time setup

1. [ ] **Project, billing, APIs.** Runbook: "One-time setup", then "1. Project, billing, APIs".
   *Done when* `gcloud services list --enabled` lists Cloud Run, Cloud Build, Artifact Registry, Cloud SQL Admin, Secret
   Manager, Cloud Storage, Identity Toolkit and the Generative Language API.
2. [ ] **Budget alert, before anything that costs money.** Runbook: "2. Budget alert". The amount is yours; use the billing
   account's currency and set the 50, 90 and 100 percent thresholds.
   *Done when* `gcloud billing budgets list --billing-account="$BILLING_ACCOUNT"` shows it.
   A budget **emails; it does not stop spending.** The hard stop is `gcloud billing projects unlink "$PROJECT_ID"`, which
   takes every service offline. Size the budget for the whole evaluation period, not the deploy day (see step 14).
3. [ ] **Artifact Registry and the two buckets.** Runbook: "3. Artifact Registry and the two buckets".
   *Done when* both buckets exist and `gcloud storage buckets describe` shows public access prevention enforced.
4. [ ] **Service accounts, least privilege.** Runbook: "4. Service accounts, least privilege".
   *Done when* the seven `munim-*` accounts exist. Leave the identity-admin role for the seed account **ungranted**; the
   seed runs as you.
5. [ ] **Cloud SQL.** Runbook: "5. Cloud SQL Postgres". Keep `--edition=ENTERPRISE` and `db-g1-small`: without the edition flag
   Postgres 16 and later defaults to a far dearer edition.
   *Done when* the instance is `RUNNABLE` and `SHOW max_connections;` (through the proxy, step 7) reports at least 50.
6. [ ] **Secrets.** Runbook: "6. Secrets". The service secret, the run-token key pair and the Gemini key go in now; enable
   Identity Platform with Email/Password and create the restricted web API key as the runbook says.
   *Done when* `gcloud secrets list` shows `munim-service-secret`, `munim-run-token-private-key`,
   `munim-run-token-public-key`, `munim-gemini-api-key` and `munim-idp-web-api-key`. Five more are created later (steps 8
   and 12). No command in the runbook prints a secret; keep it that way.

### Deploy

7. [ ] **Database: migrations, roles, packs.** Runbook: "Deploy order", "1. Database: migrations, roles, packs". Start the
   proxy, install `vector` once as the admin, then run the three database scripts.
   *Done when* `node db/migrate.ts` finishes with the latest migration applied and
   `.run/db-roles.json` exists.
8. [ ] **Role passwords into Secret Manager, then delete the file.** Runbook: "2. Put the role passwords in Secret
   Manager, then delete the file", then the per-secret access grants from "6. Secrets".
   *Done when* `.run/db-roles.json` is gone and the three `munim-db-password-*` secrets exist. **Never run
   `bootstrap-roles` again** without adding a new version of each of those three secrets and redeploying: it rotates every
   password.
9. [ ] **The four services that do not need the seed.** Runbook: "3. The four services that do not need the seed". Read the
   `--dry-run` plan first, then deploy.
   *Done when* `curl -s "$(gcloud run services describe munim-core-api --region "$REGION" --format='value(status.url)')/health"`
   answers 200 with the migration version, `munim-intel`'s `/health` answers 200 and reports its model mode (`live`), and
   `munim-suppliers-sim`'s `/health` answers 200 with the label "Simulated supplier". The first Cloud Build is the first
   image build anywhere; intel is the slowest, a few minutes.
10. [ ] **Seed Cobnut as a demo business.** Runbook: "4. Seed Cobnut as a demo business". It creates the four demo people
    and a synthetic operator, runs the one SQL step, and seeds through core-api's public API. Then do what the runbook
    calls closing the doors: **turn self-serve sign-up off.**
    *Done when* the seed prints `worldgen: cobnut seeded (…); tenant <id>` (copy the id), `select idp_sub, active from
    platform.operator;` shows the operator active, and a sign-up attempt with the web key is refused.
    Each seed is a **new tenant**; if you reseed, use the runbook's "Reseed Cobnut".
11. [ ] **The reasoning role.** Runbook: "5. The reasoning role on gemini-3.5-flash-lite". Once, after the first seed.
    *Done when* the `model-roles` call shows `reason` on `gemini-3.5-flash-lite`.
12. [ ] **The two secrets the seed produces, then web.** Runbook: "6. The two secrets the seed produces, then web". Export
    `MUNIM_DEMO_TENANT_ID` first; the script refuses to deploy web without it.
    *Done when* `munim-web` is deployed and the `grant web …` lines have run.
13. [ ] **Open the door and check.** Runbook: "7. Open the door and check". Add the web host to Identity Platform's
    authorised domains.
    *Done when* every smoke check below passes.

### Smoke checks (step 13)

Open the `munim-web` URL in a private window. These are the same pages the README's six-minute tour uses.

- [ ] `/` loads; the shop shows Cobnut Bakehouse and its two outlets.
- [ ] `/staff/sign-in` lists four people. Sign in as the owner. Every staff screen says "Sample data".
- [ ] `/staff/home`: tap a figure's source chip; the rows it came from open.
- [ ] Place a guest order on the shop and pay at the counter; the tracker updates. Sign in as the counter and the kitchen
      person in other windows and advance the ticket; the customer's tracker changes without a reload (this proves the
      stream through web's rewrite).
- [ ] `/staff/ask`: ask "Which ingredients are below their reorder level?" and get an answer with source chips. Ask something
      the books cannot answer ("What will we sell on Diwali night?") and get "Cannot verify". If a question the books can
      answer also ends in "Cannot verify", suspect `munim-intel` or the Gemini key first and read the `munim-intel` logs.
- [ ] `/staff/suppliers` shows three suppliers labelled "Simulated supplier". Request quotes for hazelnuts; a purchase-order
      draft reaches `/staff/inbox`, its quantity and price each with a source chip that opens the quote comparison. Only the
      owner can approve it.
- [ ] `/staff/inbox` shows findings (butter waste, lapsing regulars, hazelnut stock). They appear after the watchers run:
      on events, and every 15 minutes while intel is running. Wait up to 15 minutes.
- [ ] `/cares` and `/staff/cares` load; impact figures say "Measured on synthetic data".
- [ ] `…/internal/cron/v1/tick` on core-api answers 404.
- [ ] `gcloud run services list --region "$REGION"` shows five services ready.

If an organisation policy forbids `allUsers` on Cloud Run, the public services cannot be deployed unauthenticated; ask for
an exception or use a project outside that policy.

### After the deploy

14. [ ] **Keep it running.** Evaluation runs 19 Oct to 6 Nov 2026, finalists are announced 7 Nov and the finale is 4 Dec.
    Keep the services up through 6 Nov, and through 4 Dec if you are shortlisted. **Do not park them after submitting.**
    Before judging, warm the scale-to-zero services (runbook: "Cost notes", the `--min-instances=1` lines for `munim-web`
    and `munim-intel`) and relax them afterwards. The two always-on services and the database are the bill: a few days
    cost a few dollars, a month is not small (runbook estimates, unmeasured; the budget alert is the measurement).
15. [ ] **Get the URL.** The address people open is `munim-web`:
    `gcloud run services describe munim-web --region "$REGION" --format='value(status.url)'`
    It has the form `https://munim-web-<project number>.asia-south1.run.app`, with the number from
    `gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)'`. Open it from a phone on mobile data to check
    it.
16. [ ] **After the event.** Runbook: "Cost notes", "Parking after the event" (scale the always-on services to zero and stop
    the database; storage is still billed). `scripts/deploy-gcp.sh` puts the minimum instances back, and so does any push to
    `main` while the trigger of steps 17 to 21 is live: pause or delete it first (runbook, same section).

### Optional

- **Proxy hop count** (runbook: "8. Measure `MUNIM_TRUSTED_PROXY_HOPS`"). Not needed to submit. Until it is measured the
  rate limiters key on the socket address.
- **Rollback** (runbook: "Rollback"): shift traffic to an earlier revision, or redeploy an earlier tag with `--skip-build`.
  Migrations only go forward; the last resort for the database is a backup restore, which overwrites it. With continuous
  deployment on, also pause it while you look (runbook: "Continuous deployment from GitHub", "5. Roll back").

### Continuous deployment from GitHub (optional, after step 13)

After the first deploy, a Cloud Build trigger can build and deploy all five services on every push to `main`. It runs
`infra/gcp/cloudbuild-deploy.yaml`, which ends in the same `scripts/deploy-gcp.sh` with `--skip-build`. It creates nothing
and runs no migrations: steps 1 to 13 stay as they are. Runbook: "Continuous deployment from GitHub".

17. [ ] **The deploy account.** Runbook: "1. The deploy account". It needs Artifact Registry writer on the `munim` repository,
    log writer, Cloud Run admin, service account user on the five runtime accounts only, and read access to the one secret
    `munim-storefront-key`. It gets no database role and no database secret.
    *Done when* `gcloud projects get-iam-policy "$PROJECT_ID" --flatten=bindings --filter="bindings.members:munim-deploy@"
    --format='value(bindings.role)'` lists `roles/logging.logWriter` and `roles/run.admin` and nothing else.
18. [ ] **Connect the repository.** Runbook: "2. Connect the repository (once)". Use a 2nd-gen connection in `asia-south1`,
    and install the Cloud Build GitHub App on this repository only.
    *Done when* `gcloud builds repositories list --connection=munim-github --region="$REGION"` lists `food-ops-cup`.
19. [ ] **The trigger.** Runbook: "3. The trigger". Set the branch to `^main$`, the config to
    `infra/gcp/cloudbuild-deploy.yaml`, the service account to `munim-deploy`, and `_DEMO_TENANT_ID` to the tenant id from
    step 10. Leave build logs off GitHub; the repository is public.
    *Done when* `gcloud builds triggers describe munim-deploy-main --region="$REGION"` shows all four.
20. [ ] **The first build, by hand.** Runbook: "4. Run it, and watch a build".
    *Done when* the build ends `SUCCESS`, `munim-web`'s image ends in the commit's short SHA, and the smoke checks still
    pass.
21. [ ] **From then on.**
    - Before you push a commit that adds a migration, run it from your laptop (step 7); otherwise the build's `schema` step
      refuses the deploy.
    - After a reseed, give the trigger the new `_DEMO_TENANT_ID` (runbook: "Reseed Cobnut").
    - To roll back, shift traffic and pause the trigger (runbook: "5. Roll back").

## If something fails

| Symptom | Look at |
|---|---|
| A migration or `bootstrap-roles` is refused | The runbook's "First deploy: what is unverified", item 4. The proxy must still be running and `MUNIM_DB_URL_SESSION` still exported |
| The web deploy is refused | `MUNIM_DEMO_TENANT_ID` is not exported or is not well formed (the script requires the tenant id the seed printed) |
| Operator calls answer 404 during the seed | The `platform.operator` row is missing: the one SQL step in step 10 |
| A question the books can answer ends in "Cannot verify" | `munim-intel`'s logs: Gemini key, or its link to core-api |
| Streaming stalls | `munim-core-api` must have one instance with CPU always allocated; `scripts/deploy-gcp.sh` sets this |
| A trigger build fails at `check` | The trigger's `_DEMO_TENANT_ID` is missing or not the tenant id the seed printed (step 19) |
| A trigger build fails at `schema` | The commit carries a migration the database lacks: run it from your laptop (step 7), then run the trigger again |
| A trigger build fails at `deploy` with a permission error | A grant from step 17 is missing, most often service account user on one runtime account |
