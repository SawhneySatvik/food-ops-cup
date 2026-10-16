"""Provider registry (R36): Gemini via ADK's native class; OpenAI, OpenRouter and NVIDIA via ADK's OpenAILlm
(base URL + key). The operator picks provider + model per role in `platform.model_role`.

Never hand ADK a model *string*: its registry resolves `openai/...` to LiteLlm (banned) and `Gemini()` defaults
to a gemini-2.5 id. Always an explicit BaseLlm instance with its model id set, checked before and after build.

Every live model carries its role's operator price (ledger R47 D1, `trace/spend.py`), set by `llm_for_role` before any call.

Every live call has a per-role timeout (W3 close ruling; `Config.model_timeouts_s`): the classes below are ADK's own,
subclassed, so `isinstance(llm, OpenAILlm)` (the DecisionModel's request shape) and `llm.model` hold. Past the timeout
the call raises TimeoutError, which fails like any provider error: the run's RunFailed (ask → abstention, narration →
template) or the DecisionModel's `adapter_error`.

Recorded fallback (T-125, ledger R56 G-4): a live call that fails — a free-tier 429, a timeout, any provider error, or the
month's AI budget spent (`capped`: no provider call is made) — is served from the recorded fixture of that exact call
when `llm_for_role` gave the model one: the request as the recorded model would send it (its `recorded/<role>` id, keyed
before the provider's own preprocessing edits the request in place), replayed through RecordedLlm's one loader. With no
fixture the original exception is re-raised untouched, so every caller degrades exactly as before. Each response carries
the path that served it, and an abstaining exception its label (trace/served.py). A served fixture's token counts are
the authoring run's, not this call's: they are dropped, so the call is charged the request-size estimate (trace/spend.py),
as a failed call is.

Transient Gemini errors (C3; found live: flash-lite answered 5xx twice in three Asks, and once cost a supplier's quote): a call
that fails with a 5xx or a 429 is started over, at most twice in all and a 429 at most once, after a jittered wait (`retrying`).
It sits inside `bounded`, so the retries and their waits spend the role's own timeout, which the ask's budget already contains;
a timeout is never retried. A call still failing after its retries takes the path above: the recorded fixture, else the error.
Gemini only: the OpenAI-compatible client retries on its own (the SDK's default). google-genai's `HttpRetryOptions`, which ADK
passes through, cannot say "a 429 once", so it is not used. Recorded mode never reaches this file's live classes.
"""

from __future__ import annotations

import asyncio
import random
import re
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass
from typing import Any, Literal

from google.adk.integrations.openai import OpenAILlm
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai.errors import ClientError, ServerError

from munim_intel.config import Config, ProviderKeyName
from munim_intel.contracts_gen.models import PlatformModelRoleRow
from munim_intel.llm.recorded import RecordedLlm, request_key
from munim_intel.trace.price import Price
from munim_intel.trace.served import KEY, ModelPath

# Same rule as platform.model_role's CHECK (0002): any id containing gemini-2.5, any provider, any case.
_RETIRED = re.compile(r"gemini-2\.5", re.IGNORECASE)


class RetiredModelRefused(Exception):
    def __init__(self, model_id: str) -> None:
        super().__init__(f"model {model_id!r} is a gemini-2.5 model (retires 20 Oct 2026; project rule 13)")


class ProviderUnavailable(Exception):
    """A provider that cannot run here (no key). Live callers skip it loudly; it never falls back silently."""


class PriceRefused(ProviderUnavailable):
    """R47 D1: a live role with no operator price (`price_missing`), or priced in another currency than the run's spend
    (`price_currency_mismatch`; no FX is ever applied). Raised before any call; callers degrade it like any unavailable
    provider (an ask abstains `model_blocked`, narration falls back to the template)."""

    def __init__(self, code: str, role: str) -> None:
        super().__init__(f"{role}: {code}")
        self.code = code


def row_price(row: PlatformModelRoleRow) -> Price | None:
    """The role's operator price, or None when the operator has set none (any of the three columns NULL)."""
    i, o, c = row.input_price_per_mtok_minor, row.output_price_per_mtok_minor, row.price_currency
    if i is None or o is None or c is None:
        return None
    return Price(i.root, o.root, c.root)


@dataclass(frozen=True)
class Provider:
    key_name: ProviderKeyName | None
    base_url: str | None


PROVIDERS: dict[str, Provider] = {
    "gemini": Provider("GEMINI_API_KEY", None),
    # `.env.example` has no OpenAI key (rule 20): the provider exists so a role can name it, and is skipped.
    "openai": Provider(None, None),
    "openrouter": Provider("OPENROUTER_API_KEY", "https://openrouter.ai/api/v1"),
    "nvidia": Provider("NVIDIA_API_KEY", "https://integrate.api.nvidia.com/v1"),
}


async def bounded(responses: AsyncGenerator[LlmResponse, None], seconds: float) -> list[LlmResponse]:
    """Every response of one call, or TimeoutError once `seconds` pass. The whole call is awaited inside the deadline
    and only then handed on, so the deadline never spans the caller's own work between responses."""
    async with asyncio.timeout(seconds):
        return [r async for r in responses]


#: Transient-error retries (module doc): at most two starts-over per call, a 429 at most one of them.
RETRIES = 2
RETRIES_429 = 1
#: The wait before a retry, in seconds, jittered by x0.5 to x1.5: a 5xx 0.5 then 1; a 429 (a rate limit, so longer) 2.
BACKOFF_5XX_S = 0.5
BACKOFF_429_S = 2.0
#: Module attributes so a test can replace the wait and the jitter.
_sleep = asyncio.sleep
_jitter = random.uniform


def transient(e: BaseException) -> Literal["5xx", "429"] | None:
    """What kind of transient provider error `e` is, by google-genai's own classes (ADK's `_ResourceExhaustedError` is a
    ClientError with code 429); None: not transient, never retried (a 400, a timeout, a validation error)."""
    if isinstance(e, ServerError):
        return "5xx"
    if isinstance(e, ClientError) and e.code == 429:
        return "429"
    return None


async def retrying(make: Callable[[], AsyncGenerator[LlmResponse, None]]) -> AsyncGenerator[LlmResponse, None]:
    """The responses of `make()`, starting the call over when it fails with a transient error (module doc). An attempt's
    responses are collected before any is yielded (`bounded` collects them anyway), so a retry never repeats a response."""
    left, left_429, waits = RETRIES, RETRIES_429, 0
    while True:
        try:
            responses = [r async for r in make()]
        except Exception as e:  # noqa: BLE001 — anything not transient is re-raised untouched
            kind = transient(e)
            if kind is None or left == 0 or (kind == "429" and left_429 == 0):
                raise
            left -= 1
            if kind == "429":
                left_429 -= 1
                wait = BACKOFF_429_S
            else:
                wait = BACKOFF_5XX_S * 2**waits
                waits += 1
            await _sleep(wait * _jitter(0.5, 1.5))
            continue
        for r in responses:
            yield r
        return


class OverCap(Exception):
    """The month's AI budget is spent (R47): no provider call is made, and the call takes the fallback path as a 429 does."""


async def served(llm: TimedGemini | TimedOpenAILlm, req: LlmRequest, call: AsyncGenerator[LlmResponse, None]) -> list[LlmResponse]:
    """One live-mode call: `call` (the provider's, not started yet) within the timeout, else the fallback (module doc)."""
    fallback = llm.fallback
    key = None if fallback is None else request_key(req.model_copy(update={"model": fallback.model}))
    path: ModelPath
    try:
        if llm.capped:
            await call.aclose()
            raise OverCap()
        responses, path = await bounded(call, llm.timeout_s), "live"
    except Exception as e:  # noqa: BLE001 — every failure takes the same path; a miss re-raises the exception untouched
        replayed = None if fallback is None or key is None else fallback.replay(key[0], key[2])
        if replayed is None:
            setattr(e, KEY, "abstained")
            raise
        responses, path = [r.model_copy(update={"usage_metadata": None}) for r in replayed], "recorded-fallback"
    return [r.model_copy(update={"custom_metadata": {**(r.custom_metadata or {}), KEY: path}}) for r in responses]


#: The JSON-schema keywords sent to Gemini: the part of its documented `response_json_schema` subset these schemas use.
#: The rest (`minLength`, `maxLength`, `pattern`, `default`) are left out — UNVERIFIED that each alone is refused; the
#: claims schema, which carries all four, answered 200 without them (R63).
_GEMINI_KEYWORDS = frozenset(
    ("type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum", "enum", "anyOf")
    + ("title", "description")
)


def _gemini_schema(node: Any) -> Any:
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for k, v in node.items():
        if k not in _GEMINI_KEYWORDS:
            continue
        if k == "properties":
            out[k] = {name: _gemini_schema(s) for name, s in v.items()}
        elif k == "anyOf":
            out[k] = [_gemini_schema(s) for s in v]
        else:
            out[k] = _gemini_schema(v)
    return out


def gemini_request(req: LlmRequest) -> LlmRequest:
    """The request as the Gemini API accepts it (R63, measured on gemini-3.5-flash-lite and gemini-3.8-flash; codes only).
    A JSON-schema dict in `response_schema` (the quarantine's Pydantic schemas: supplier quotes, claims, invoice vision) is
    sent as `response_json_schema`: `response_schema` is Google's OpenAPI subset, which has no `additionalProperties`, so
    the API answered it 400 on every model. Keywords outside `_GEMINI_KEYWORDS` are left out; the response is still
    validated against the whole Pydantic schema after it comes back (ingest.quarantine.call). A `types.Schema` (the
    router's enum) stays as it is. A copy: the caller's request keys the recorded fallback (`served`) unchanged."""
    schema = req.config.response_schema
    if not isinstance(schema, dict):
        return req
    config = req.config.model_copy(update={"response_schema": None, "response_json_schema": _gemini_schema(schema)})
    return req.model_copy(update={"config": config})


class TimedGemini(Gemini):
    timeout_s: float = 60.0
    price: Price | None = None
    #: The recorded fixtures that may serve a failed call (T-125); None: a failed call only fails (the live probe).
    fallback: RecordedLlm | None = None
    #: The month's AI budget is spent: every call takes the fallback path, none reaches the provider.
    capped: bool = False

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        sent = gemini_request(llm_request)
        for r in await served(self, llm_request, retrying(lambda: super(TimedGemini, self).generate_content_async(sent, stream))):
            yield r


class TimedOpenAILlm(OpenAILlm):
    timeout_s: float = 60.0
    price: Price | None = None
    fallback: RecordedLlm | None = None
    capped: bool = False

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        for r in await served(self, llm_request, super().generate_content_async(llm_request, stream)):
            yield r


def refuse_retired(model_id: str) -> None:
    if _RETIRED.search(model_id):
        raise RetiredModelRefused(model_id)


def build_live_llm(row: PlatformModelRoleRow, cfg: Config, price: Price | None = None) -> TimedGemini | TimedOpenAILlm:
    """`price`: the role's operator price, which `llm_for_role` (every run's path) always sets; None only for the live
    provider probe (tests/live), which posts no spend rows."""
    refuse_retired(row.model_id)
    provider = PROVIDERS.get(row.provider)
    if provider is None:
        raise ProviderUnavailable(f"unknown provider {row.provider!r}")
    if provider.key_name is None:
        raise ProviderUnavailable(f"{row.provider}: no API key name in .env.example — skipped")
    key = cfg.provider_key(provider.key_name)
    if key is None:
        raise ProviderUnavailable(f"{row.provider}: {provider.key_name} is not set — skipped")
    timeout_s = cfg.model_timeouts_s[row.role]
    llm: TimedGemini | TimedOpenAILlm
    if row.provider == "gemini":
        llm = TimedGemini(model=row.model_id, client_kwargs={"api_key": key}, timeout_s=timeout_s, price=price)
    else:
        llm = TimedOpenAILlm(model=row.model_id, api_key=key, base_url=provider.base_url, timeout_s=timeout_s, price=price)
    refuse_retired(llm.model)
    return llm
