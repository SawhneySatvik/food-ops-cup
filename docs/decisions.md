# Design decisions

The choices that shape Munim, each with the reason and where to see it in the code. They are written as decisions that were
made, not as options. All data is synthetic, suppliers are simulated and payments are recorded, never processed.

## 1. The AI layer has no write path

intel has no database client. Its only way to change anything is a draft posted to core-api, which a person approves.
The import-linter contract in `pyproject.toml` forbids a database driver in `munim_intel`. The database role that serves
intel's routes, `munim_svc`, has no insert or update grant on any book table.
*Why:* a guarantee that depends on the model behaving is not a guarantee. This one holds when the model is wrong, injected
or replaced.

## 2. The database enforces the guarantee, not just the API

A trigger on every book table, `core.guard_book_write()`, admits a write only for a person's own command, an approved
decision executing in the same transaction, or an allow-listed derivation. There is no bypass, not even for the migration
owner.
*Why:* an API check protects the API. A migration, a worker, a new route or a mistake in a handler would each bypass it.
The trigger holds for all of them. See `docs/data-model.md`.

## 3. Nothing auto-applies

Every AI proposal is a draft: a command with its evidence and the snapshots it is based on. Approval re-checks the
approver's authority on the final payload, re-runs the snapshots (a changed number makes the draft stale), then executes the
command as the approver with its audit entry in one transaction. Auto mode for investigations only re-runs read-only steps.
*Why:* the product's value is that an owner can trust a suggestion enough to act on it quickly, and the cost of a wrong
automatic change is a wrong book.

## 4. Numbers are cited, never typed

A number a person reads is rendered from a cell of a SQL snapshot that core-api minted. Models write handles
(`{S1.r0.net_minor}`); code expands them to refs; core validates every ref and refuses prose with a free digit, number word,
percent sign or typed quotation. If a number cannot be traced, the screen says "Cannot verify".
*Why:* a language model cannot be made reliable at arithmetic or recall, but a system can refuse anything it did not
compute. See `docs/ai-agents.md`.

## 5. The tenant is never a model argument

core-api signs a short-lived Ed25519 run token that carries the tenant and outlet scope. intel holds only the public key.
Tools are built around the verified token, and no tool schema has a tenant parameter; a test reflects over every tool.
*Why:* if the tenant can be an argument, a prompt injection can change it.

## 6. Row-level security is forced, and context is transaction-local

Every tenant table has forced row-level security, and the runtime roles own no tables. A transaction states its context with
`SET LOCAL`. *Why:* table owners bypass row-level security unless it is forced, and a session-level `SET` leaks across a
pooled connection to the next request. Both are silent failures, so both are tested.

## 7. Books are append-only

No role has `DELETE`. A correction is a reversal or a void with a reason and an actor. Journal entries balance per currency
at commit, and a posting must join an entry created in the same transaction.
*Why:* an accountant needs the trail more than the tidy table.

## 8. Commands are idempotent, and events leave in the same transaction

Every command has an idempotency key and a request hash. The outbox row is written in the command's own transaction and
published after commit; a worker sweeps stragglers. Notifications carry ids only.
*Why:* a network retry must not double a sale, and a notification must not become a way to read data.

## 9. Postgres is the bus

Live updates use `LISTEN`/`NOTIFY` and server-sent events, with a resumable cursor, rather than a message broker. Clients
use fetch-based SSE so the bearer token travels in a header.
*Why:* one fewer system to run and secure, and the volume of a small chain does not need more. The cost is that each core-api
process holds a long-lived `LISTEN` connection, so on Cloud Run core-api keeps its CPU always allocated, because a throttled
instance would stall that connection. The deployment also runs a single core-api instance, which keeps the per-instance rate
limiter exact.

## 10. No country logic in code

A country pack is a versioned JSON document for currency, time zones, tax, invoice rules, aggregator formats, payroll scope,
licences and detector thresholds. A test scans the `core-domain` source for literals that name a pack. Money is integer
minor units with a currency, time is `timestamptz` with IANA zones, and a business's country is fixed after onboarding.
*Why:* adding Australia should be a data change. India is live and the Australia pack is complete.

## 11. Decide in code, narrate with a model

Where an answer can be computed, it is. Investigation verdicts are evaluated by core. Negotiation counter prices come from a
rule policy, and deal review is five deterministic rules. A model chooses among moves the policy allows and writes a short
note, and code renders the numbers.
*Why:* a bounded model on an unbounded decision is the part that fails. A model on a bounded decision is the part that helps.

## 12. Untrusted text is quarantined

Supplier replies and documents are read by a model call with no tools. The run is then tainted and cannot propose a draft.
Extracted fields are grounded in the reply's own text, and traces hold labels, never text.
*Why:* an LLM that reads untrusted text and holds tools is one injection from an action.

## 13. Models are data, and tests do not call them

Each role (router, reason, extract, narrate, vision, embed) is a row in `platform.model_role` with a provider, a model id and a
price, changed only by an approved config draft. Every test runs on committed recorded responses. In live mode a failed or
over-budget call is served from the recorded answer for that exact request when one exists, and AI surfaces otherwise
degrade to template text or hide, never to an error state.
*Why:* a demo that falls over when a quota runs out is worse than one that gets quieter. The database refuses a retired
model family.

## 14. ADK sessions are in memory

Each run uses a fresh in-memory ADK session. intel persists nothing and the ADK database session service is not used.
*Why:* it keeps intel stateless and makes "intel has no write path" true of ADK too.

## 15. Suppliers and recipients are simulated, and say so

The three supplier agents are programs; the Cares recipients are rows. Every screen that shows them says so, and the
database refuses a quote from a supplier that is not of kind `simulated`. See `docs/simulation-policy.md`.

## 16. One long-running worker process

core-worker is a single long-running process, with CPU always allocated, that runs the outbox sweep and the scheduled jobs.
A job still running skips its next boundary. When two workers overlap during a rollout, the outbox sweep's advisory lock
and row leases keep one sender per event, and core's event claim lets intel handle each event once.
*Why:* request-billed instances throttle CPU between requests, which stalls a background subscriber.

## 17. Public services behind secrets, not a private network

On Google Cloud, intel and the supplier simulator accept public traffic. intel requires the service secret on every route but
`/health`, and a run token on most. The database has a public address with no authorised networks and is reached through
Cloud Run's built-in connection.
*Why:* a private network adds a VPC, a private-IP database and several settings for no code-level gain, since the secret is
already checked on every call. See `infra/gcp/README.md`.

## 18. Original art

Every shape and icon in the web app is hand-drawn inline SVG or CSS; there are no icon packs or stock images. Fonts are
Fraunces and Inter (SIL OFL). `apps/web/README.md` carries a dated art log.
