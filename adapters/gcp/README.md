# adapters/gcp

Google Cloud adapters behind the existing ports. Each is a factory function; the composition root picks it by env.
Nothing here needs an SDK: JSON REST over `fetch`, bearer tokens from the Cloud Run metadata server.

## idp-identity-platform (IdP port, `services/core-api/src/auth/port.ts`)

- `identityPlatformIdp({ projectId })` verifies Identity Platform ID tokens: RS256, Google's securetoken JWKS,
  `iss = https://securetoken.google.com/<project>`, `aud = <project>`. `email_verified` is Google's signed claim.
- `ensureDemoAccounts(...)` / `demoPassword(runDir)` create the four Cobnut demo users `<key>@cobnut-demo.invalid`
  with one generated password (admin REST, metadata token). CLI: `node adapters/gcp/idp-identity-platform/demo-accounts.ts`.
- `passwordGrant({ apiKey, email, password })` is the server-side sign-in (`accounts:signInWithPassword`) for the web
  app's demo sign-in. Errors carry the status only.

Env: `MUNIM_IDP=identity-platform`, `MUNIM_IDP_PROJECT_ID`, `MUNIM_IDP_WEB_API_KEY` (public by design).

## blob-gcs (BlobStore port, `services/core-api/src/modules/imports/blob.ts`)

`gcsBlobStore({ bucket })` stores `<tenant>/<sha256>` objects in Cloud Storage (JSON API).
Env: `MUNIM_BLOB=gcs`, `MUNIM_BLOB_BUCKET`.

## IAM roles for the Cloud Run service account

- Bucket (grant on the bucket, not the project): `roles/storage.objectAdmin` (create, overwrite, read objects).
- Demo-account job only: `roles/firebaseauth.admin` (create and update users).
- Token verify and password grant need no role (public JWKS, public web API key).
- Secrets: `roles/secretmanager.secretAccessor` on the secrets the revision mounts (infra/gcp).

All routes are UNVERIFIED against a live project until the first deploy.

## Tests

`cd adapters/gcp/<adapter> && node node_modules/vitest/vitest.mjs run` (no network; local servers on 4370-4371).
