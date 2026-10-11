"""T-059: live provider smoke, DM-mimic logprobs probe and budget measurement.

Run only by `make smoke-live` (MUNIM_MODEL_MODE=live). Never part of `make check` / `make test`, which stay recorded.
Cost cap: at most ONE call per provider per role per run, <= 64 output tokens, planned count printed first and
hard-failed above providers x roles (+ 1 per keyed Gemini: the router's one unscored retry). Keys come only through
munim_intel.config; errors print as class name + code, never message text (provider errors can echo request details).

The router cell is the real DecisionModel (LlmMimic, route.intent, one draft-like question): on Gemini it asks for
logprobs and, if they are rejected, retries once without them (T-081 dm-1), so it costs up to 2 calls.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import get_args

from google.adk.models.llm_request import LlmRequest
from google.genai import types

from munim_intel.config import Config, load_repo_config
from munim_intel.contracts_gen.models import PlatformModelRoles
from munim_intel.decide.mimic import LlmMimic
from munim_intel.decide.questions import ROUTE_INTENT
from munim_intel.llm import ModelRoleName
from munim_intel.llm.providers import PROVIDERS, ProviderUnavailable, build_live_llm, refuse_retired
from munim_intel.runtime.context import RunContext

INTEL = Path(__file__).resolve().parents[2]
REPO = INTEL.parents[1]
ROLES: tuple[str, ...] = get_args(ModelRoleName)
PROMPT = "Reply with the single word: ok"
MAX_OUT = 64
# ADK's OpenAILlm exposes no logprobs request field, so the OpenAI-compatible providers cannot be probed through it.
LOGPROBS_ROLE = "router"
DM_QUESTION = "Order 20 kg of onions from our usual supplier"
#: decide() never reads the context (egress is the state alone); placeholder ids, never verified.
DM_CTX = RunContext(
    "01920000-0000-7000-8000-0000000000e1",
    "01920000-0000-7000-8000-0000000000f1",
    ("*",),
    "ask",
    "01920000-0000-7000-8000-0000000000d1",
    4_102_444_800,
    "not-a-token",
)


@dataclass
class Cell:
    status: str  # ok | skipped | failed
    detail: str = ""
    ms: int | None = None
    prompt: int | None = None
    completion: int | None = None
    cached: int | None = None
    logprobs: bool | None = None
    #: Provider calls this cell cost (the router: 2 when logprobs were rejected and retried without).
    calls: int = 1


def worst_calls(provider: str, role: str) -> int:
    """Planned calls for one cell: the Gemini router may retry once (LlmMimic requests logprobs only on Gemini)."""
    return 2 if provider == "gemini" and role == LOGPROBS_ROLE else 1


@dataclass
class Outcome:
    cells: dict[tuple[str, str], Cell] = field(default_factory=dict)
    planned: int = 0
    made: int = 0


# A call: (provider, role, model_id, cfg) -> Cell. Injectable so the gates run it without the network.
Caller = Callable[[str, str, str, Config], Awaitable[Cell]]


def err(e: BaseException) -> str:
    code = getattr(e, "code", None) or getattr(e, "status_code", None)
    return f"{type(e).__name__}" + (f" code={code}" if code else "")


def model_ids(provider: str) -> dict[str, str]:
    """Gemini ids come from the committed copy of platform.model_role (0015). Other providers have none in the
    repo: an operator supplies one per role with MUNIM_LIVE_MODEL_<PROVIDER>_<ROLE>; never invented here."""
    out: dict[str, str] = {}
    rows = PlatformModelRoles.model_validate_json((INTEL / "fixtures" / "model_roles_0015.json").read_text("utf8")).items
    for r in rows:
        if r.provider == provider:
            out[r.role] = r.model_id
    for role in ROLES:
        v = (os.environ.get(f"MUNIM_LIVE_MODEL_{provider.upper()}_{role.upper()}") or "").strip()
        if v:
            out[role] = v
    return out


async def live_call(provider: str, role: str, model_id: str, cfg: Config) -> Cell:
    from google.adk.models.llm_response import LlmResponse
    from google.genai import Client

    from munim_intel.contracts_gen.models import PlatformModelRoleRow

    t0 = time.monotonic()
    if role == "embed":
        key = cfg.provider_key("GEMINI_API_KEY")
        if provider != "gemini" or key is None:
            return Cell("skipped", "embed probed on gemini only")
        r = await Client(api_key=key).aio.models.embed_content(
            model=model_id, contents="ping", config=types.EmbedContentConfig(output_dimensionality=768)
        )
        dims = len(r.embeddings[0].values or []) if r.embeddings else 0
        return Cell("ok", f"dims={dims}", int((time.monotonic() - t0) * 1000), logprobs=None)
    row = PlatformModelRoleRow.model_validate(
        {
            "role": role,
            "provider": provider,
            "model_id": model_id,
            "location": "global",
            # The smoke probes reachability, not spend: no price (R47 D1); build_live_llm takes none outside a run.
            "input_price_per_mtok_minor": None,
            "output_price_per_mtok_minor": None,
            "price_currency": None,
            "probed_at": None,
            "updated_at": "2026-10-10T00:00:00Z",
        }
    )
    llm = build_live_llm(row, cfg)
    if role == LOGPROBS_ROLE:
        [d] = await LlmMimic(llm).decide(
            DM_CTX, {"question": DM_QUESTION, "outlet_kinds": ("restaurant",), "country": "IN"}, [ROUTE_INTENT]
        )
        detail = f"route.intent={d.answer or '-'} band={d.band} calls={d.model_calls}" + (f" abstained={d.reason}" if d.abstained else "")
        # A provider failure (adapter_error: the call, or the call and its one retry, failed) or an out-of-enum answer is a
        # failed cell; below_threshold is a model judgement, not a smoke failure.
        return Cell(
            "failed" if d.reason in ("adapter_error", "decision_invalid") else "ok",
            detail,
            d.latency_ms,
            d.input_tokens,
            logprobs=d.probs_bp is not None,
            calls=d.model_calls,
        )
    req = LlmRequest(
        model=model_id,
        contents=[types.Content(role="user", parts=[types.Part(text=PROMPT)])],
        config=types.GenerateContentConfig(max_output_tokens=MAX_OUT),
    )
    last: LlmResponse | None = None
    async for resp in llm.generate_content_async(req, stream=False):
        last = resp
    ms = int((time.monotonic() - t0) * 1000)
    if last is None or last.error_code:
        return Cell("failed", f"LlmResponse error_code={getattr(last, 'error_code', None)}", ms)
    u = last.usage_metadata
    return Cell(
        "ok",
        "",
        ms,
        u.prompt_token_count if u else None,
        u.candidates_token_count if u else None,
        u.cached_content_token_count if u else None,
    )


async def run_matrix(cfg: Config, caller: Caller = live_call) -> Outcome:
    out = Outcome()
    plan: list[tuple[str, str, str]] = []
    for provider, p in PROVIDERS.items():
        key = p.key_name and cfg.provider_key(p.key_name)
        ids = model_ids(provider)
        for role in ROLES:
            if not key:
                out.cells[(provider, role)] = Cell("skipped", "no key")
            elif role not in ids:
                out.cells[(provider, role)] = Cell("skipped", "no model id")
            else:
                try:
                    refuse_retired(ids[role])
                except Exception as e:  # noqa: BLE001 - class name only
                    out.cells[(provider, role)] = Cell("failed", err(e))
                    continue
                plan.append((provider, role, ids[role]))
    out.planned = sum(worst_calls(p, r) for p, r, _ in plan)
    keyed = [p for p, v in PROVIDERS.items() if v.key_name and cfg.provider_key(v.key_name)]
    cap = len(keyed) * len(ROLES) + ("gemini" in keyed)
    print(f"PLAN: {out.planned} live call(s) at most; cap providers-with-key x roles + gemini router retry = {cap}")
    if out.planned > cap:
        raise SystemExit(f"FAIL: planned calls {out.planned} exceed cap {cap}")
    for provider, role, mid in plan:
        try:
            out.cells[(provider, role)] = await caller(provider, role, mid, cfg)
        except ProviderUnavailable as e:
            # Raised while building the model, before any request: no call was made.
            out.cells[(provider, role)] = Cell("skipped", err(e), calls=0)
        except Exception as e:  # noqa: BLE001 - any provider failure is reported by class + code only
            # The call (or the router's call and its retry) may have been made and billed: counted at its planned worst.
            out.cells[(provider, role)] = Cell("failed", err(e), None, calls=worst_calls(provider, role))
        out.made += out.cells[(provider, role)].calls
    return out


def adr_rows() -> list[str]:
    """The §3.4 row labels, parsed from the ADR itself (independent of this file's own list)."""
    text = (REPO / "docs/plan/adr/ADR-014-intelligence-layer.md").read_text("utf8")
    sec = text.split("### 3.4 Budgets", 1)[1].split("**Tenant ladder**", 1)[0]
    rows = [ln for ln in sec.splitlines() if ln.startswith("| ") and not ln.startswith("| Run kind") and not ln.startswith("|---")]
    return [ln.split("|")[1].strip() for ln in rows]


def est_tokens(chars: int) -> int:
    return round(chars / 3.5)


def fixture_estimate(globs: list[str]) -> tuple[int, int, int] | None:
    """(max request tokens, max response tokens, n fixtures) from recorded fixtures that carry a request."""
    reqs: list[int] = []
    resps: list[int] = []
    for g in globs:
        for f in (INTEL / "tests").glob(g):
            d = json.loads(f.read_text("utf8"))
            if "request" not in d:
                continue
            reqs.append(len(json.dumps(d["request"], ensure_ascii=False)))
            resps.append(len(json.dumps(d.get("responses"), ensure_ascii=False)))
    return (est_tokens(max(reqs)), est_tokens(max(resps)), len(reqs)) if reqs else None


# ADR §3.4 row label -> (source). "live": the tiny router call; "fixtures": recorded request sizes; None: not a call.
ROW_SOURCES: dict[str, tuple[str, list[str]] | None] = {
    "DM question": ("live:router", []),
    "narrate (finding or investigation step)": ("fixtures", ["investigate/fixtures/narrate/*.json"]),
    "brief": ("fixtures", ["brief/fixtures/*.json"]),
    "ask, single agent": ("fixtures", ["manager/fixtures/reason/*.json", "manager/fixtures/threads/reason/*.json"]),
    "ask, fan-out: orchestrator": ("fixtures", ["fanout/fixtures/e2e/reason/*.json"]),
    "ask, fan-out: each branch": ("fixtures", ["fanout/fixtures/reason/*.json"]),  # carry no request: reported n/a
    "ask, fan-out run total": None,
    "investigation step": ("fixtures", ["investigate/fixtures/narrate/*.json"]),
    "investigation lifetime": None,
    "drafts per ask run": None,
}


def token_table(out: Outcome) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    missing: list[str] = []
    rows = adr_rows()
    for label in rows:
        if label not in ROW_SOURCES:
            missing.append(label)
            lines.append(f"{label:<42} | MISSING")
            continue
        src = ROW_SOURCES[label]
        if src is None:
            lines.append(f"{label:<42} | n/a: a total or a count, not a single call kind")
        elif src[0].startswith("live:"):
            c = out.cells.get(("gemini", src[0][5:]))
            if c and c.status == "ok":
                lines.append(
                    f"{label:<42} | measured (route.intent via LlmMimic, gemini/router, {c.calls} call(s), {c.detail}): "
                    f"prompt={c.prompt} completion={c.completion if c.completion is not None else 'not reported'}"
                )
            else:
                lines.append(f"{label:<42} | measured: unavailable (no ok gemini router call this run)")
        else:
            e = fixture_estimate(src[1])
            lines.append(
                f"{label:<42} | estimate (fixtures, chars/3.5, max of {e[2]}): prompt~{e[0]} completion~{e[1]}"
                if e
                else f"{label:<42} | estimate: n/a (no recorded fixture carries a request)"
            )
    for r in ROW_SOURCES:
        if r not in rows:
            missing.append(f"(table row not in ADR) {r}")
    if len(rows) != 10:
        missing.append(f"ADR row count {len(rows)} != 10")
    return lines, missing


def report(out: Outcome) -> int:
    print("\nPROVIDER x ROLE MATRIX")
    for (provider, role), cell in out.cells.items():
        extra = f" {cell.ms}ms" if cell.ms is not None else ""
        d = f" ({cell.detail})" if cell.detail else ""
        print(f"{provider:<11} {role:<8} {cell.status.upper() if cell.status != 'skipped' else 'skipped'}{extra}{d}")
    print("\nDM-MIMIC LOGPROBS PROBE (router role)")
    for provider in PROVIDERS:
        c = out.cells.get((provider, LOGPROBS_ROLE))
        if provider == "gemini" and c and c.status == "ok":
            if c.logprobs:
                print(f"{provider:<11} supported")
            elif c.calls == 2:
                print(f"{provider:<11} unsupported (logprobs request rejected; retried once without: {c.detail})")
            else:
                print(f"{provider:<11} unsupported (response carried no logprobs: {c.detail})")
        elif provider == "gemini":
            ids = model_ids(provider)
            twin = any(
                r != LOGPROBS_ROLE and ids.get(r) == ids.get(LOGPROBS_ROLE) and out.cells[(provider, r)].status == "ok" for r in ROLES
            )
            why = f"{c.detail}; same model id ok on another role without logprobs" if c and twin else (c.detail if c else "no call")
            print(f"{provider:<11} {'unsupported (request with logprobs rejected: ' + why + ')' if twin else 'not probed (' + why + ')'}")
        else:
            print(f"{provider:<11} unsupported through ADK OpenAILlm (known limitation: no logprobs request field)")
    print("\nMEASURED TOKENS PER ADR-014 §3.4 ROW")
    lines, missing = token_table(out)
    print("\n".join(lines))
    print("\nPER-CALL USAGE (live, tiny prompt)")
    for (provider, role), c in out.cells.items():
        if c.status == "ok" and c.prompt is not None:
            cached = c.cached if c.cached is not None else "not reported"
            print(f"{provider}/{role}: prompt={c.prompt} completion={c.completion} cached={cached}")
    print(f"\nLIVE CALLS MADE: {out.made} (planned {out.planned})")
    bad = [k for k, c in out.cells.items() if c.status == "failed"]
    if missing:
        print("RED: missing table rows: " + "; ".join(missing))
    if bad:
        print("RED: failed: " + ", ".join(f"{p}/{r}" for p, r in bad))
    return 1 if (bad or missing) else 0


def main() -> int:
    cfg = load_repo_config(REPO)
    if cfg.model_mode != "live":
        print("smoke-live refuses to run: MUNIM_MODEL_MODE is not 'live' (this is the only live-model lane)")
        return 2
    for name, p in PROVIDERS.items():
        if not (p.key_name and cfg.provider_key(p.key_name)):
            print(
                f"SKIPPED LOUDLY: provider {name}: no key"
                + (f" ({p.key_name} not set)" if p.key_name else " (no key name in .env.example)")
            )
    return report(asyncio.run(run_matrix(cfg)))


if __name__ == "__main__":
    sys.exit(main())
