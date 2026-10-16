"""The quarantine (project rule 8; ADR-014 §6.4 rules 1 and 3). An extraction or vision call is one request with no
tools and a JSON response schema, sent straight to the role's BaseLlm — no ADK agent, so there is no tool table to
reach. The run is tainted before the call: the untrusted text is in a context of the run from then on, whatever the
call returns. A response that tries a function call is refused whole (nothing in it is used), and nothing executes it.

Every call spends the run's model budget (`state.budget`, the same counter the ADK plugin keeps for agent calls): with
the budget spent, no call is made (`ai_budget_cap`). Every call that reaches the provider is also one spend row on the
run's meter buffer (R47, 04 §10; C1 S2-6), charged as the `extract` or `vision` role at this model's price — as the
plugin charges agent calls — so the monthly cap sees it; a state with no meter posts none. A provider failure leaves
as `ModelUnavailable` carrying only a code (`model_error:<exception class>`), raised outside the handler so neither
`__cause__` nor `__context__` holds the provider's text — which may quote a key, the prompt, or the untrusted input itself.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel, ValidationError

from munim_intel.config import Config
from munim_intel.llm import ModelRoleSource, llm_for_role, price_of, provider_of
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.runtime.state import ACTOR, RunState
from munim_intel.trace.served import ModelPath, served_by
from munim_intel.trace.spend import Meter, Usage, estimate_input_tokens

#: Recorded extractor and vision responses (SYNTHETIC; written by tests/ingest/make_fixtures.py).
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


class QuarantineBreach(Exception):
    """`request_has_tools` (a bug here) or `tool_call_attempted` (the model tried to act). The message is the code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Unreadable(Exception):
    """The response is not the schema's JSON. The message is a code, never the model's text."""


class ModelUnavailable(Exception):
    """No answer: the run's budget is spent (`ai_budget_cap`) or the provider failed (`model_error:<class>`). Code only."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def tool_count(req: LlmRequest) -> int:
    """Every way a request can offer the model a tool: config tools (function declarations or built-ins) and ADK's
    tools_dict."""
    n = len(req.tools_dict)
    for t in req.config.tools or []:
        declarations = getattr(t, "function_declarations", None)
        n += len(declarations) if declarations else 1
    return n


def _inline(schema: dict[str, Any]) -> dict[str, Any]:
    """A Pydantic JSON schema with its `$defs` substituted in place (providers' response schemas take no refs)."""
    defs = schema.pop("$defs", {})

    def sub(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return sub(dict(defs[node["$ref"].rsplit("/", 1)[1]]))
            return {k: sub(v) for k, v in node.items()}
        if isinstance(node, list):
            return [sub(v) for v in node]
        return node

    out: dict[str, Any] = sub(schema)
    return out


def build_request(llm: BaseLlm, system: str, parts: list[types.Part], schema: type[BaseModel]) -> LlmRequest:
    config = types.GenerateContentConfig(
        system_instruction=system,
        temperature=0,
        response_mime_type="application/json",
        response_schema=_inline(schema.model_json_schema()),
    )
    return LlmRequest(model=llm.model, contents=[types.Content(role="user", parts=parts)], config=config)


def _charge(meter: Meter | None, req: LlmRequest, last: LlmResponse | None) -> None:
    """One spend row for a call that reached the provider (as the plugin's after_model / on_model_error): the provider's
    count when the answer reports one (thinking billed as output), else the request's size estimate — a refused, failed or
    unreported call is never a free one."""
    if meter is None:
        return
    usage = last.usage_metadata if last is not None else None
    if usage is not None and usage.prompt_token_count is not None:
        meter.record(Usage(usage.prompt_token_count, (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0)))
    else:
        meter.record(Usage(estimate_input_tokens(req), 0, estimated=True))


async def call[M: BaseModel](
    llm: BaseLlm,
    req: LlmRequest,
    schema: type[M],
    state: RunState,
    actor: str | None = None,
    role: Literal["extract", "vision"] = "extract",
) -> M:
    """`actor`: who the path label is traced under (default: the running context's, ACTOR). `role`: what the call is charged
    as on the run's meter (the vision read passes `vision`)."""
    if tool_count(req) != 0:
        raise QuarantineBreach("request_has_tools")
    budget = state.budget
    # Check and count with no await between (as the plugin does), so concurrent callers cannot both take the last call.
    if budget.models_exhausted():
        raise ModelUnavailable("ai_budget_cap")
    budget.model_calls += 1
    state.tainted = True
    meter = None if state.meter is None else Meter(state.meter.buffer, role, provider_of(llm), llm.model, price_of(llm))
    last: LlmResponse | None = None
    failed: str | None = None
    path: ModelPath | None = None
    try:
        async for resp in llm.generate_content_async(req, stream=False):
            parts = (resp.content.parts or []) if resp.content else []
            if any(p.function_call is not None for p in parts):
                raise QuarantineBreach("tool_call_attempted")
            if resp.usage_metadata is not None:
                budget.input_tokens += resp.usage_metadata.prompt_token_count or 0
                budget.output_tokens += resp.usage_metadata.candidates_token_count or 0
            if not resp.partial:
                last = resp
    except QuarantineBreach:
        # The provider answered (with a function call): charged, by estimate, before the refusal leaves.
        _charge(meter, req, None)
        raise
    except Exception as e:  # noqa: BLE001 — re-raised below as a code, outside this handler
        failed = f"model_error:{type(e).__name__}"
        path = served_by(e)
    else:
        path = served_by(last)
    _charge(meter, req, last)
    # T-125: which path served a live call (live, recorded-fallback, abstained) — a label only; a recorded replay carries none.
    if path is not None:
        await state.traces.append("route", actor or ACTOR.get(), {"model_path": path})
    if failed is not None:
        raise ModelUnavailable(failed)
    text = "".join(p.text or "" for p in (last.content.parts or []) if not p.thought) if last and last.content else ""
    try:
        return schema.model_validate(json.loads(text))
    except (ValueError, ValidationError):
        raise Unreadable("response_not_schema") from None


async def quarantined_llm(role: Literal["extract", "vision"], cfg: Config, roles: ModelRoleSource) -> BaseLlm:
    """The `extract` or `vision` role. Recorded mode replays this package's fixtures; live mode falls back to them (T-125)."""
    if cfg.model_mode == "recorded":
        return RecordedLlm(model=f"recorded/{role}", fixtures_dir=FIXTURES_DIR)
    # The ingest route builds no run-frame yet, so there is no spend currency to match the price against (the negotiation's
    # extractor is built by llm_for_role with the run's currency); a role with no price is still refused.
    return await llm_for_role(role, cfg, roles, currency=None, fallback_dir=FIXTURES_DIR)
