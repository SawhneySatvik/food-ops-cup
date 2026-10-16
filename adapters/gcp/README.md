# adapters/gcp

Google Cloud adapters behind the existing ports. Each is a factory function; the composition root picks it by env.
Nothing here needs an SDK: JSON REST over `fetch`, bearer tokens from the Cloud Run metadata server.

## idp-identity-platform (IdP port, `services/core-api/src/auth/port.ts`)

- `identityPlatformIdp({ projectId })` verifies Identity Platform ID tokens: RS256, Google's securetoken JWKS,
  `iss = https://securetoken.google.com/<project>`, `aud = <project>`. `email_verified` is Google's signed claim.
- `ensureDemoAccounts(...)` / `demoPassword(runDir)` create (or reset) the four Cobnut demo users
  `<key>@cobnut-demo.invalid`, email-verified, with one generated password (admin REST, metadata-server token). CLI:
  `MUNIM_IDP_PROJECT_ID=… MUNIM_IDP_WEB_API_KEY=… node adapters/gcp/idp-identity-platform/demo-accounts.ts` prints their
  ID tokens. Its admin token comes from the metadata server, so it runs only where that answers (a Cloud Run job).
- `passwordGrant({ apiKey, email, password })` is the server-side sign-in (`accounts:signInWithPassword`) for the web
  app's demo sign-in. Errors carry the status only.

Env: core-api reads `MUNIM_IDP=identity-platform` and `MUNIM_IDP_PROJECT_ID`. The CLI and the web app's demo sign-in read
`MUNIM_IDP_WEB_API_KEY` (public by design); the demo sign-in also reads `MUNIM_DEMO_SIGNIN`, `MUNIM_IDP`,
`MUNIM_DEMO_PASSWORD` and `MUNIM_DEMO_TENANT_ID`.

## blob-gcs (BlobStore port, `services/core-api/src/modules/imports/blob.ts`)

`gcsBlobStore({ bucket })` stores `<tenant>/<sha256>` objects in Cloud Storage (JSON API).
Env: `MUNIM_BLOB=gcs`, `MUNIM_BLOB_BUCKET`.

## IAM roles for the Cloud Run service accounts

- Blobs bucket (grant on the bucket, not the project): core-api's account `roles/storage.objectAdmin` (create, overwrite,
  read objects); core-worker's account `roles/storage.objectViewer` (it only reads).
- Demo-account job only: `roles/firebaseauth.admin` (create and update users), granted for that run and removed after.
- Token verify and password grant need no role (public JWKS, public web API key).
- Secrets: `roles/secretmanager.secretAccessor` on the secrets the revision mounts (infra/gcp).

The tests below stand in for Google's endpoints and make no Google calls. The adapters are exercised against a real
project only by a deploy, following [`infra/gcp/README.md`](../../infra/gcp/README.md).

## Run and test

```bash
pnpm -F @munim/idp-identity-platform test
pnpm -F @munim/blob-gcs test
pnpm -F @munim/idp-identity-platform typecheck
pnpm -F @munim/blob-gcs typecheck
```

Tests make no external call. The Identity Platform tests inject a `fetch` that plays Google's JWKS and Identity Toolkit
endpoints. The blob tests start local HTTP servers for the Cloud Storage JSON API (port 4370) and the metadata server
(port 4371), so binary bodies and URL encoding are exercised for real.
