"""LlmMimic (ADR-014 §4.2): the approved LLM on the `router` role (R45 F2: no other role, no new processor) asked to
pick a single-letter option code under the provider's own constraint, with token logprobs as probabilities.

Request: system = the question's committed instructions + the code table; user = the egress payload as JSON (and
nothing else — the RunContext is never read for content). Constraint per provider:
- Gemini (and the recorded replay of it): `text/x.enum` with a STRING enum of the codes, `response_logprobs` on.
- OpenAI-compatible (OpenRouter, NVIDIA via ADK `OpenAILlm`): strict `json_schema` `{"answer": enum}`. FACT
  (installed ADK 2.11 `integrations/openai/_openai_llm.py`): OpenAILlm neither requests nor returns logprobs, so
  this path always yields `probs_bp = None`.

No probabilities. FACT (T-059 smoke, dm-1 probe, 11 Oct): Gemini answers 400 (`ClientError`) to a logprobs request on
both approved ids (`gemini-3.5-flash-lite`, `gemini-3.8-flash`) and accepts the same enum request without them. So a
400 on a logprobs request is retried ONCE without logprobs under the same enum, when the question accepts an unscored
answer (`use_unscored`, route.intent only); otherwise it abstains `no_probabilities` with no retry (the answer would be
discarded anyway). An answer that simply carries no logprobs (OpenAILlm, or a provider that drops them) is not
retried — a second call would return the same nothing. Either way: band `unscored` if the question accepts it, else
band low → abstained `no_probabilities` → the caller's fallback.

`RecordedDecision` is this adapter over a RecordedLlm whose fixtures live in `decide/fixtures/`, so every gate runs
the real request builder, constraint, code mapping and logprob renormalisation.
"""

from __future__ import annotations

import json
import math
import time
from collections.abc import Mapping, Sequence
from pathlib import Path

from google.adk.integrations.openai import OpenAILlm
from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError

from munim_intel.config import Config
from munim_intel.decide.port import DecisionQuestion, DecisionResult, DecisionState, egress_payload, finish
from munim_intel.llm import ModelRoleSource, llm_for_role, price_of, provider_of
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.runtime.context import RunContext
from munim_intel.trace.served import ModelPath, served_by
from munim_intel.trace.spend import Usage, estimate_input_tokens

CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
#: Gemini's top-k logprobs cap (UNVERIFIED; T-059). Options beyond the top k get 0 bp.
TOP_K = 20


def codes_for(q: DecisionQuestion) -> dict[str, str]:
    """code -> option, in option order."""
    return {CODES[i]: o for i, o in enumerate(q.options)}


def build_request(llm: BaseLlm, q: DecisionQuestion, state: DecisionState, logprobs: bool = True) -> LlmRequest:
    """The whole request. `egress_payload` runs first and raises EgressRefused before anything is built. `logprobs`
    False: the same request and constraint without asking for probabilities (the retry after a rejection)."""
    payload = egress_payload(q, state)
    codes = codes_for(q)
    system = q.instructions + "\n\nAnswer with exactly one code.\n" + "\n".join(f"{c} = {o}" for c, o in codes.items())
    if isinstance(llm, OpenAILlm):
        config = types.GenerateContentConfig(
            system_instruction=system,
            temperature=0,
            response_mime_type="application/json",
            response_schema={
                "type": "object",
                "properties": {"answer": {"type": "string", "enum": list(codes)}},
                "required": ["answer"],
                "additionalProperties": False,
            },
        )
    else:
        config = types.GenerateContentConfig(
            system_instruction=system,
            temperature=0,
            response_mime_type="text/x.enum",
            response_schema=types.Schema(type=types.Type.STRING, enum=list(codes)),
            response_logprobs=True if logprobs else None,
            logprobs=min(len(codes), TOP_K) if logprobs else None,
        )
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return LlmRequest(model=llm.model, contents=[types.Content(role="user", parts=[types.Part(text=text)])], config=config)


def _code_of(text: str) -> str:
    """A token or answer with its JSON quoting and whitespace removed."""
    return text.strip().strip('"').strip()


def parse_answer(resp: LlmResponse) -> str | None:
    """The code the model chose: bare (`B`) under text/x.enum, or `{"answer": "B"}` under strict JSON."""
    text = "".join(p.text or "" for p in (resp.content.parts or []) if not p.thought) if resp.content else ""
    text = text.strip()
    if text.startswith("{"):
        try:
            answer = json.loads(text).get("answer")
        except (ValueError, AttributeError):
            return None
        return answer if isinstance(answer, str) else None
    return _code_of(text) or None


def probabilities(resp: LlmResponse, code: str, codes: Sequence[str]) -> dict[str, int] | None:
    """The answer token's top-k logprobs, renormalised over the option codes, in basis points summing to exactly
    10,000 (largest remainder). None when the provider gave no logprobs for the answer token."""
    lr = resp.logprobs_result
    if lr is None or not lr.chosen_candidates or not lr.top_candidates:
        return None
    at = next((i for i, c in enumerate(lr.chosen_candidates) if _code_of(c.token or "") == code), None)
    if at is None or at >= len(lr.top_candidates):
        return None
    seen: dict[str, float] = {}
    for c in [*(lr.top_candidates[at].candidates or []), lr.chosen_candidates[at]]:
        k = _code_of(c.token or "")
        # The same option can arrive as several tokens (`B`, ` B`); a token is counted once per spelling.
        if k in codes and c.log_probability is not None and (c.token or "") not in seen:
            seen[c.token or ""] = c.log_probability
    mass: dict[str, float] = dict.fromkeys(codes, 0.0)
    for tok, lp in seen.items():
        mass[_code_of(tok)] += math.exp(lp)
    total = sum(mass.values())
    if total <= 0:
        return None
    exact = {k: v / total * 10_000 for k, v in mass.items()}
    bp = {k: math.floor(v) for k, v in exact.items()}
    for k in sorted(codes, key=lambda k: bp[k] - exact[k])[: 10_000 - sum(bp.values())]:
        bp[k] += 1
    return bp


class LlmMimic:
    def __init__(self, llm: BaseLlm, adapter: str = "llm_mimic") -> None:
        self._llm = llm
        self._adapter = adapter

    async def decide(self, ctx: RunContext, state: DecisionState, qs: Sequence[DecisionQuestion]) -> list[DecisionResult]:
        # Every request is built (and its egress checked) before the first call: one bad question refuses them all.
        requests = [(q, build_request(self._llm, q, state)) for q in qs]
        return [await self._ask(q, state, req) for q, req in requests]

    async def _call(self, req: LlmRequest) -> tuple[LlmResponse | None, bool, ModelPath | None]:
        """(the final response or None, whether the provider rejected a request that asked for logprobs, the path that
        served the call — live mode only, trace/served.py)."""
        last: LlmResponse | None = None
        try:
            async for resp in self._llm.generate_content_async(req, stream=False):
                if not resp.partial:
                    last = resp
        except ClientError as e:  # a 429 is a ClientError too: only a 400 on a logprobs request is a rejection
            return None, e.code == 400 and bool(req.config.response_logprobs), served_by(e)
        except Exception as e:  # noqa: BLE001 — a provider failure is an abstain (rule 11); its text never leaves here
            return None, False, served_by(e)
        return last, False, served_by(last)

    async def _ask(self, q: DecisionQuestion, state: DecisionState, req: LlmRequest) -> DecisionResult:
        started = time.monotonic()
        codes = codes_for(q)
        calls = 1
        last, rejected, path = await self._call(req)
        usage = [_usage(req, last)]
        if rejected and q.use_unscored:
            calls = 2
            retry = build_request(self._llm, q, state, logprobs=False)
            last, _, path = await self._call(retry)
            usage.append(_usage(retry, last))
        ms = int((time.monotonic() - started) * 1000)
        tokens = (last.usage_metadata.prompt_token_count or 0) if last is not None and last.usage_metadata else 0

        def done(answer: str | None, probs: Mapping[str, int] | None, error: bool = False, unscorable: bool = False) -> DecisionResult:
            return finish(
                q,
                answer,
                probs,
                adapter=self._adapter,
                model_id=self._llm.model,
                input_tokens=tokens,
                latency_ms=ms,
                error=error,
                unscorable=unscorable,
                model_calls=calls,
                call_usage=tuple(usage),
                provider=provider_of(self._llm),
                price=price_of(self._llm),
                model_path=path,
            )

        if rejected and not q.use_unscored:
            return done(None, None, unscorable=True)
        if last is None or last.error_code is not None:
            return done(None, None, error=True)
        code = parse_answer(last)
        if code is None or code not in codes:
            # Not one of the codes (an option's name, prose, an out-of-enum letter) → decision_invalid.
            return done(None, None)
        probs = probabilities(last, code, list(codes))
        return done(codes[code], None if probs is None else {codes[k]: v for k, v in probs.items()})


def _usage(req: LlmRequest, resp: LlmResponse | None) -> Usage:
    """One call's spend row: the provider's count, or the request-size estimate when it reported none (or failed)."""
    u = resp.usage_metadata if resp is not None else None
    if u is None or u.prompt_token_count is None:
        return Usage(estimate_input_tokens(req), 0, estimated=True)
    return Usage(u.prompt_token_count, (u.candidates_token_count or 0) + (u.thoughts_token_count or 0))


async def router_decision_model(cfg: Config, roles: ModelRoleSource, *, currency: str, capped: bool = False) -> LlmMimic:
    """The W3 decision model: the `router` role only (F2), priced in the run's spend `currency` (R47 D1: refused before
    any call when the router has no price, or one in another currency). Recorded mode replays `decide/fixtures/`. `capped`:
    over the month's AI cap (llm.over_cap), the call is served from those fixtures or abstains."""
    if cfg.model_mode == "recorded":
        return recorded_decision()
    # Live: a failed call is served from this package's fixtures when it has one (T-125), as recorded mode replays them.
    return LlmMimic(await llm_for_role("router", cfg, roles, currency=currency, fallback_dir=FIXTURES_DIR, capped=capped))


def recorded_decision(fixtures_dir: Path = FIXTURES_DIR) -> LlmMimic:
    return LlmMimic(RecordedLlm(model="recorded/router", fixtures_dir=fixtures_dir), adapter="recorded")
