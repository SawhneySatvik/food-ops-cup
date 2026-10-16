# services/intel

Munim Intelligence: a Python 3.12 service on Google ADK 2.11 that routes questions to a Manager and eight specialists,
explains what happened with citations, finds money leaks and drafts actions. **It cannot write.** It has no database client
(an import-linter contract in the root `pyproject.toml` forbids one), and every output goes to core-api's internal routes,
where core validates it. A person approves every change. All data is synthetic and suppliers are simulated.

The design is in [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and [`docs/ai-agents.md`](../../docs/ai-agents.md).

## Entry points

| File | What it does |
|---|---|
| `munim_intel/__main__.py` | `python -m munim_intel`: serves the app on `MUNIM_INTEL_URL`'s host and port (default `127.0.0.1:8081`) |
| `munim_intel/asgi.py` | The ASGI entry used in the container image |
| `munim_intel/app.py` | The FastAPI app: `/health`, `/events`, `/watch:sweep`, `/brief`, `/ask`, `/investigate:narrate`, `/negotiate`, `/ingest`, `/smoke` |
| `munim_intel/config.py` | The one config module: provider keys, model mode, timeouts, redaction of secrets in errors and logs |

Every route except `/health` needs core's service secret, and every run also needs a run token that core minted. intel holds
only the public key.

## Layout

Paths are under `munim_intel/`, except `fixtures/`, which sits beside it.

| Path | What it holds |
|---|---|
| `manager/` | One ask end to end (`ask.py`) and the table from the six `route.intent` intents to four paths (`paths.py`) |
| `decide/` | The constrained decision model behind `route.intent` and the import column mapper |
| `skills/<pack>/` | The eight specialists: `catalogue`, `kitchen`, `inventory_purchasing`, `finance`, `people`, `customers`, `compliance`, `market`; `loader.py` binds a skill's tools just in time |
| `tools/` | Generated `read_*` and `propose_*` tools, the cell-handle table, `submit_answer`, the number grammar |
| `runtime/` | `RunContext` built from a run token, the internal client, the ADK runner, per-run state and budget |
| `context/` | The context assembler: what each model call sees |
| `detect/`, `watch/`, `events/`, `brief/`, `narrate/`, `mapping/` | Detector specs and their registry, the watcher pipeline and each specialist's detectors, event handling, the daily brief, finding narration, detection-to-draft mapping |
| `investigate/` | Narration of one investigation step |
| `negotiate/` | The supplier negotiation: policy, chooser, extractor, deal review, simulated-only check |
| `fanout/` | The Manager's `fan_out` tool: up to four read-only specialist branches |
| `forecast/` | A deterministic demand forecast, no model |
| `ingest/`, `wiki/`, `graph/` | Extraction, wiki compiler, graph port with a Postgres-edges adapter. The negotiation uses the quarantined extractor (`ingest/quarantine.py`), and the Menu & Pricing and Stock & Purchasing skills carry the `graph_*` tools, which query core's Postgres edges; no route calls document ingestion, the wiki compiler or the projector (`graph/project.py`) yet |
| `llm/` | Provider classes and the recorded model (`RecordedLlm`) |
| `trace/` | The ADK plugin, the trace buffer and spend meter |
| `contracts_gen/` | Pydantic models generated from `packages/contracts`; never edited by hand |
| `fixtures/recorded/` | Committed model responses, keyed by a hash of the request |

## Run and test

```bash
uv run --locked --directory services/intel python -m munim_intel      # serves on MUNIM_INTEL_URL (default 127.0.0.1:8081)
uv run --locked --directory services/intel --with pytest==9.1.1 pytest -q
```

intel reaches core-api at `MUNIM_CORE_URL` (unset: `http://127.0.0.1:<PORT>`, `PORT` 8787 by default). It answers
every route but `/health` with `503` until it has the service secret (`MUNIM_SERVICE_SECRET`, else `.run/service-secret`
at the repository root) and core's run-token public key (`MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM`, else `.run/keys/run-token-ed25519.pub.pem`); core-api
writes both files on its first start. `python -m munim_intel` reads provider keys from the environment or the
repository's `.env` file.

Every test runs with `MUNIM_MODEL_MODE=recorded` (the default): model calls are served from `fixtures/recorded/`, the network
and any environment file are blocked, and a missing fixture fails the test. Live mode (`MUNIM_MODEL_MODE=live`) needs a
provider key; `GEMINI_API_KEY`, `NVIDIA_API_KEY` and `OPENROUTER_API_KEY` are read by name through `config.py` only.
A model id matching `gemini-2.5` is refused, and `litellm` and ADK's `[eval]`, `[extensions]`, `[all]` and `[test]` extras
are forbidden (`tests/test_lockfile.py`).

Some tests start a real core-api over an embedded Postgres through the `.mts` stacks beside them (for example `tests/manager/ask_stack.mts`).
