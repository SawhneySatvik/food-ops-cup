# @munim/contracts

The runtime contract between every part of Munim, written once as zod schemas. From them the package generates the OpenAPI
documents, the JSON Schemas, the TypeScript SDK types and intel's Pydantic models, so the TypeScript and Python halves cannot
drift apart.

## What it holds

- `src/<module>/index.ts`: one folder per domain (accounts, ai_policy, approvals, cares, catalogue, compliance, customers,
  events, finance, findings, goals, imports, intel, internal, inventory, investigations, kitchen, lineage, orders, packs,
  people, platform, purchasing, specialists, storefront, tenancy, threads). Each exports `SCHEMAS` and `ROUTES`; the
  generators discover modules by folder.
- `src/shared/`: the command envelope (`command.ts`), the error body and codes (`error.ts`), reason codes
  (`reason-codes.ts`), refs (`refs.ts`), answer envelopes (`envelope.ts`), the draft payload rule (`draft.ts`), run-token claims
  (`run-token.ts`), snapshots, traces, CloudEvents, and the number grammar (`grammar/`).
- `src/intel/specialists.ts`: the registry of the eight specialists, the Manager and the Forecast service, with their
  snapshot templates, detectors and draftable commands.
- `src/ontology/`: the transform that turns snapshot templates and draftable commands into model-facing tool schemas.
- `packs/IN.json` and `packs/AU.json`: the country packs, seeded into `platform.country_pack` by `db/seeds/packs.ts`.
- `generated/`: `openapi/public.json` (`/v1` and `/platform/v1`), `openapi/internal.json` (`/internal/intel/v1`),
  `json-schema/`, `ontology.json` and `sources.sha256.json` (the freshness stamp).
- `MANIFEST.d/`: hand-kept lists of the schema names each module must register. The generator never reads them; tests do.

## Generate

```bash
pnpm -F @munim/contracts gen              # JSON Schema, OpenAPI, SDK types, Pydantic models, and the stamp
node packages/contracts/scripts/ontology.ts   # generated/ontology.json (after gen and after any migration change)
```

`gen` writes `packages/contracts/generated/`, `packages/sdk/src/gen/` and `services/intel/munim_intel/contracts_gen/`. It
fetches `datamodel-code-generator` through `uvx`. Generated files are committed, and a test fails if they are stale.

## Run and test

```bash
pnpm -F @munim/contracts test
pnpm -F @munim/contracts typecheck
```

| Test | Proves |
|---|---|
| `stale.test.ts` | The generated files match the stamp, so a stale or hand-edited file fails |
| `count.test.ts` | The number of generated JSON Schemas equals the hand-kept `MANIFEST.d/` lists |
| `roundtrip.test.ts` | Every sample goes zod, then the generated Pydantic model, then zod again, and is equal |
| `routes.test.ts` | No two routes share a method and path or an operation id |
| `guarantee.test.ts` | A draft proposed by intel cannot carry a model-typed number |
| `grammar.test.ts`, `refs.test.ts` | The number grammar and the ref syntax |

See [`docs/api.md`](../../docs/api.md) for the API this describes.
