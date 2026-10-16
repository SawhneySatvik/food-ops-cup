# @munim/config

The one configuration module for the TypeScript services. It reads the environment, holds Munim's internal settings,
builds per-role database URLs, and **redacts every secret value from errors and logs**. Nothing else in the TypeScript code
reads provider keys or database passwords.

## What it does

- **Names.** `ENV_NAMES` lists the five names an environment file may hold: `GEMINI_API_KEY`, `NVIDIA_API_KEY`,
  `OPENROUTER_API_KEY`, `MUNIM_DB_URL_SESSION` and `MUNIM_DB_URL_TRANSACTION`. Every other setting comes from the process
  environment. `MUNIM_MODEL_MODE` is `recorded` (the default) or `live`.
- **Database URLs.** `config.dbUrl(role)` and `config.sessionDbUrl(role)` return the base URL logged in as `munim_core`,
  `munim_svc` or `munim_platform`, with that role's password from `MUNIM_DB_PASSWORD_<ROLE>` or from `.run/db-roles.json`
  (written by `db/scripts/bootstrap-roles.ts`).
- **Internal settings.** The service secret, the run-token key pair, ports, timeouts, the stream's maximum age and the
  blob-store mode (`MUNIM_BLOB`: `fs`, the default, or `gcs`) default in code or come from the environment or from files
  under `.run/`. The identity-provider mode has no default: `MUNIM_IDP` must be `identity-platform` or `local`, and
  `resolveIdpMode` refuses `local` unless `MUNIM_ENV=dev`, and always under `NODE_ENV=production`.
- **Redaction.** Every registered secret (keys, URLs with passwords, role passwords) is replaced in `Config.redact`, which
  `createLogger` applies to every line and error.

## Entry points

`src/index.ts` is the whole package. The main exports are `loadRepoConfig(root)` (the process entry's loader),
`loadConfig(options)` (what tests use, with `env` passed in directly so no file is read), `createLogger(config)`,
`resolveIdpMode`, `ensureRunDir` and the `Config` interface.

```ts
import { createLogger, loadRepoConfig } from "@munim/config";

const config = loadRepoConfig(root);
const log = createLogger(config);          // secrets redacted
const url = config.dbUrl("munim_core");
```

## Run and test

```bash
pnpm -F @munim/config test
pnpm -F @munim/config typecheck
```

`test/config.test.ts` passes planted, synthetic values in directly and never reads a real environment file. On the
Python side, intel has its own config module, `services/intel/munim_intel/config.py`. The variable names used on Google
Cloud are in the table in
[`infra/gcp/README.md`](../../infra/gcp/README.md).
