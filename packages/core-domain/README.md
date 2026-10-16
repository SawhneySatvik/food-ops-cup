# @munim/core-domain

Framework-free domain logic shared by core-api, core-worker and the tests. No Hono, no React, no database client: functions
take plain values and return plain values, so the rules can be tested without a server.

## What it holds

| Folder | What it does |
|---|---|
| `money/` | Money as integer minor units plus a currency: `money`, `add`, `sub`, `sum`, `allocate`, `mulDiv`, `formatMoney` |
| `tz/` | One time-zone module: `localDate`, `businessDate` (with the outlet's day cutoff, default 04:00), `dayBounds`, `slots`. DST-correct for any IANA zone |
| `packs/` | The country-pack engine: `orderTax`, `buildReceipt`, `renderReceipt`, `cashTender`, `payrollDrafted`. Country behaviour comes from the pack document, never from a code branch |
| `authority/` | `evaluateAuthority` (who may issue a command, from `core.command_authority` rows) and `outletScopeOf` |
| `envelope/` | The number grammar (`checkGrammar`) and the cite-or-abstain validator (`validateSegments`, `validateFinding`, `validateDraft`) behind a ref-resolver port |
| `inventory/` | Deterministic stock derivations: `consumeOrder`, `consumeSku`, recipe unit validation |
| `finance/` | Chart of accounts for a pack, posting rules (`postOrder` and others), reversal, the Tally export |
| `investigations/` | Playbooks as data (`margin_fall`) and the pure functions that judge items and compute status. No model sets a verdict |
| `cares/` | The Munim Cares rules: unit conversion, hand-over splits, claim totals |
| `storefront/` | The storefront theme contrast judge |
| `rules.ts` | The list of derivation rules this package implements; a test requires each to match a seeded `core.derivation_rule` row |

## Run and test

```bash
pnpm -F @munim/core-domain test
pnpm -F @munim/core-domain typecheck
```

`test/` covers: the DST suite (both `Australia/Melbourne` transitions, `Asia/Kolkata` as the control, `tz.test.ts`);
golden receipts and tax totals for the India and Australia packs (`test/goldens/`); money and rounding; the validator with
forged-ref, cross-tenant-ref and free-digit cases (`validator.test.ts`); `country-literals.test.ts`, which scans the source
for any literal that names a country pack; and `rules-parity.test.ts`, which compares this package's rules with the
migrations'.

Import a folder directly, for example `import { businessDate } from "@munim/core-domain/tz"` (the package exports `./*` as
`./*/index.ts`).
