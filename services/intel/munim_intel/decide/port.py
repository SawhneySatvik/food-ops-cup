"""The DecisionModel port (ADR-014 §4.1). Every adapter's raw output passes through `finish`, so the answer-set and
probability checks hold whatever the adapter or provider does (R6c: a schema-shaped answer is not a correct one).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from munim_intel.runtime.context import RunContext
from munim_intel.trace.price import Price
from munim_intel.trace.served import ModelPath
from munim_intel.trace.spend import Usage

Kind = Literal["choice", "score", "predicate"]
KINDS: tuple[Kind, ...] = ("choice", "score", "predicate")
#: `unscored`: the provider gave an answer but no probabilities, and the question accepts that (T-081 / T-059: the
#: approved Gemini ids reject logprobs). It is a label like the others, never a figure.
Band = Literal["low", "medium", "high", "unscored"]
AbstainReason = Literal["below_threshold", "decision_invalid", "no_probabilities", "adapter_error"]

#: A request carries only strings. The values a caller puts here are the ONLY data that may leave the process.
DecisionState = Mapping[str, str | tuple[str, ...]]

#: An option is a lower-case slug that starts with a letter: never a number, never prose.
OPTION = re.compile(r"[a-z][a-z0-9_]*")
#: Adapters render options as single-letter codes, so a question has at most 26 (ADR §4.2 said A…H; `map.columns`
#: for pos_bills needs 26).
MAX_OPTIONS = 26
#: ≈ 300 tokens (ADR §4.1).
MAX_INSTRUCTIONS_CHARS = 1200
#: Provisional band cut: no ledger entry fixes one (R40 C5 says only "a band"). `medium` starts at the question's
#: threshold; below it the result is abstained.
HIGH_BP = 9_000

_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


@dataclass(frozen=True)
class DecisionQuestion:
    key: str
    version: int
    kind: Kind
    options: tuple[str, ...]
    #: Committed text sent with every request; ≤ 300 tokens.
    instructions: str
    #: The ONLY state fields that may leave the process (§4.3). A request must carry exactly these.
    egress: frozenset[str]
    #: Below this probability of the answer → abstained → the caller's deterministic fallback.
    threshold_bp: int
    #: What the caller does when the result is abstained; None = leave it for a person.
    fallback: str | None
    #: Per egress field, the pattern every string value must fully match (closed sets, codes).
    value_patterns: Mapping[str, str] = field(default_factory=dict)
    #: The import kind for `map.columns` (one question per kind, so every answer set is finite and fixed in code).
    variant: str | None = None
    #: Act on an answer that came without probabilities (band `unscored`) instead of abstaining `no_probabilities`.
    #: Only for a question whose every option leads somewhere bounded and fail-safe (route.intent); default: abstain.
    use_unscored: bool = False

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"{self.key}: kind must be one of {KINDS}")
        if self.kind == "predicate" and self.options != ("no", "yes"):
            raise ValueError(f"{self.key}: a predicate's options are exactly ('no', 'yes')")
        if not 2 <= len(self.options) <= MAX_OPTIONS or len(set(self.options)) != len(self.options):
            raise ValueError(f"{self.key}: 2..{MAX_OPTIONS} distinct options")
        if not all(OPTION.fullmatch(o) for o in self.options):
            raise ValueError(f"{self.key}: every option is a slug")
        if not 0 < self.threshold_bp <= HIGH_BP:
            raise ValueError(f"{self.key}: threshold_bp in 1..{HIGH_BP}")
        if self.fallback is not None and self.fallback not in self.options:
            raise ValueError(f"{self.key}: fallback must be an option or None")
        if len(self.instructions) > MAX_INSTRUCTIONS_CHARS:
            raise ValueError(f"{self.key}: instructions over {MAX_INSTRUCTIONS_CHARS} chars")
        if not set(self.value_patterns) <= self.egress:
            raise ValueError(f"{self.key}: value_patterns name a field outside egress")


@dataclass(frozen=True)
class DecisionResult:
    key: str
    #: One of the question's options, or None when abstained — callers use `answer_or_fallback`.
    answer: str | None
    #: Basis points per option, summing to 10,000 ±1; None when the provider gave no probabilities. Never shown.
    probs_bp: Mapping[str, int] | None
    #: The only thing ever shown (R40 C5).
    band: Band
    abstained: bool
    reason: AbstainReason | None
    adapter: str
    model_id: str
    input_tokens: int
    latency_ms: int
    #: Provider calls this result cost: 2 when a request with logprobs was rejected and retried without (budget).
    model_calls: int = 1
    #: Each provider call's usage, in call order (one spend row each; W3 close ruling). The DecisionModel runs before any
    #: RunState exists, so the caller posts these.
    call_usage: tuple[Usage, ...] = ()
    #: The provider the spend rows name (`gemini` for a recorded replay).
    provider: str = "gemini"
    #: The router role's operator price the spend rows are charged at (R47 D1); None for a replay → 0.
    price: Price | None = None
    #: Live mode: the path that served the last provider call (trace/served.py, T-125); None for a replay.
    model_path: ModelPath | None = None


class DecisionModel(Protocol):
    """Implemented in W3 by `LlmMimic` only (F2). Jev, OpenAI Decisions and a fine-tuned Gemma are deferred (§13.3)."""

    async def decide(self, ctx: RunContext, state: DecisionState, qs: Sequence[DecisionQuestion]) -> list[DecisionResult]: ...


class EgressRefused(Exception):
    """A request that would send more than the question allows. Raised before any network call. The message names
    the field and the rule, never a value (the value is what must not leak)."""

    def __init__(self, key: str, field_name: str, rule: str) -> None:
        super().__init__(f"{key}: egress refused for field {field_name!r} ({rule})")
        self.field_name = field_name
        self.rule = rule


def egress_payload(q: DecisionQuestion, state: DecisionState) -> dict[str, str | list[str]]:
    """The exact data that leaves the process for `q`, or EgressRefused. The tenant is never here: the state is
    built by the caller from labels and the member's own text, and nothing is read from the RunContext."""
    for name in sorted(state):
        if name not in q.egress:
            raise EgressRefused(q.key, name, "not_allow_listed")
    for name in sorted(q.egress):
        if name not in state:
            raise EgressRefused(q.key, name, "missing")
    out: dict[str, str | list[str]] = {}
    for name in sorted(q.egress):
        value = state[name]
        items: tuple[object, ...] = (value,) if isinstance(value, str) else value if isinstance(value, tuple) else (None,)
        texts = [v for v in items if isinstance(v, str)]
        if len(texts) != len(items):
            raise EgressRefused(q.key, name, "not_text")
        pattern = q.value_patterns.get(name)
        for v in texts:
            if _UUID.search(v):
                raise EgressRefused(q.key, name, "uuid")
            if pattern is not None and not re.fullmatch(pattern, v):
                raise EgressRefused(q.key, name, "value_not_allowed")
        out[name] = value if isinstance(value, str) else texts
    return out


def band_of(q: DecisionQuestion, p_bp: int | None) -> Band:
    if p_bp is None or p_bp < q.threshold_bp:
        return "low"
    return "high" if p_bp >= HIGH_BP else "medium"


def finish(
    q: DecisionQuestion,
    raw_answer: object,
    probs_bp: Mapping[str, int] | None,
    *,
    adapter: str,
    model_id: str,
    input_tokens: int,
    latency_ms: int,
    error: bool = False,
    unscorable: bool = False,
    model_calls: int = 1,
    call_usage: tuple[Usage, ...] = (),
    provider: str = "gemini",
    price: Price | None = None,
    model_path: ModelPath | None = None,
) -> DecisionResult:
    """Re-validate an adapter's raw output (§4.2): the answer must be an option and the probabilities a full
    distribution over the options; anything else is `decision_invalid`. No probabilities → band `unscored` when the
    question accepts it, else band low → abstained `no_probabilities` (also when `unscorable`: the provider refused
    probabilities and no answer was asked for)."""

    def result(answer: str | None, probs: Mapping[str, int] | None, band: Band, reason: AbstainReason | None) -> DecisionResult:
        return DecisionResult(
            key=q.key,
            answer=answer,
            probs_bp=probs,
            band=band,
            abstained=reason is not None,
            reason=reason,
            adapter=adapter,
            model_id=model_id,
            input_tokens=input_tokens,
            latency_ms=latency_ms,
            model_calls=model_calls,
            call_usage=call_usage,
            provider=provider,
            price=price,
            model_path=model_path,
        )

    if error:
        return result(None, None, "low", "adapter_error")
    if unscorable:
        return result(None, None, "low", "no_probabilities")
    if not isinstance(raw_answer, str) or raw_answer not in q.options:
        return result(None, None, "low", "decision_invalid")
    if probs_bp is None:
        return result(raw_answer, None, "unscored", None) if q.use_unscored else result(None, None, "low", "no_probabilities")
    if set(probs_bp) != set(q.options) or any(not isinstance(v, int) or v < 0 for v in probs_bp.values()):
        return result(None, None, "low", "decision_invalid")
    if abs(sum(probs_bp.values()) - 10_000) > 1:
        return result(None, None, "low", "decision_invalid")
    p = probs_bp[raw_answer]
    if p < q.threshold_bp:
        return result(None, None, "low", "below_threshold")
    return result(raw_answer, dict(probs_bp), band_of(q, p), None)


def answer_or_fallback(q: DecisionQuestion, r: DecisionResult) -> str | None:
    """The value deterministic code acts on: the answer, or the question's fallback when abstained."""
    return q.fallback if r.abstained else r.answer
