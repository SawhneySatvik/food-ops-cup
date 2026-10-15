"""Role -> model (R36). Recorded mode never consults a provider; live mode reads platform.model_role from core."""

from __future__ import annotations

from pathlib import Path
from typing import Literal, Protocol

from google.adk.integrations.openai import OpenAILlm
from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.contracts_gen.models import InternalRunFrameResponse, PlatformModelRoles
from munim_intel.llm.providers import PROVIDERS, PriceRefused, ProviderUnavailable, build_live_llm, row_price
from munim_intel.llm.recorded import FIXTURES_DIR, RecordedLlm
from munim_intel.trace.price import Price

ModelRoleName = Literal["router", "reason", "extract", "narrate", "vision", "embed"]


class ModelRoleSource(Protocol):
    async def model_roles(self) -> PlatformModelRoles: ...


async def llm_for_role(
    role: ModelRoleName,
    cfg: Config,
    roles: ModelRoleSource,
    *,
    currency: str | None,
    fallback_dir: Path | None = FIXTURES_DIR,
    capped: bool = False,
) -> BaseLlm:
    """The role's model, carrying its operator price (R47 D1). Live: refused before any call when the operator set no
    price, or a price in another currency than `currency` — the run's spend currency (`spend_currency(frame)`); None
    only for a caller that posts no spend rows. Recorded: a replay with no price (charged 0).

    Live (T-125, R56 G-4): a call that fails is served from the fixture of that exact call under `fallback_dir` (as the
    recorded `recorded/<role>` model reads them), else fails as before; None for a probe, which a fixture must never
    pass. `capped`: the month's AI budget is spent — no call reaches the provider (so none is charged: no price), each
    takes that fallback path."""
    if cfg.model_mode == "recorded":
        return RecordedLlm(model=f"recorded/{role}")
    row = next((r for r in (await roles.model_roles()).items if r.role == role), None)
    if row is None:
        raise ProviderUnavailable(f"no platform.model_role row for {role!r}")
    price = row_price(row)
    if price is None:
        raise PriceRefused("price_missing", role)
    if currency is not None and price.currency != currency:
        raise PriceRefused("price_currency_mismatch", role)
    llm = build_live_llm(row, cfg, None if capped else price)
    llm.capped = capped
    if fallback_dir is not None:
        llm.fallback = RecordedLlm(model=f"recorded/{role}", fixtures_dir=fallback_dir)
    return llm


def over_cap(cfg: Config, ai_enabled: bool | None, budget_level: str | None) -> bool:
    """T-127 (R58; T-125's open item): live mode, AI switched on (the run-frame's `ai_enabled`, the typed kill switch alone) and
    the month's AI budget spent (budget level `hard`). Such a run still builds its models, `capped`: no call reaches the provider
    and each is served from the recorded fixture of that exact call or abstains. Never with AI switched off (no AI answer, not
    even a recorded one), with no budget for the month (R47 D2: AI declines) or in recorded mode (every gate replays as before).
    Every model gate reads this rule; none restates it."""
    return cfg.model_mode == "live" and ai_enabled is True and budget_level == "hard"


def frame_over_cap(cfg: Config, frame: InternalRunFrameResponse | None) -> bool:
    """`over_cap` of a run-frame (no frame: no model)."""
    return frame is not None and over_cap(cfg, frame.ai_enabled, frame.budget.level if frame.budget is not None else None)


def price_of(llm: BaseLlm) -> Price | None:
    """The price `llm_for_role` set on it (live), a test's own (recorded), or None: a replay or a test double, charged 0."""
    price = getattr(llm, "price", None)
    return price if isinstance(price, Price) else None


def cause(e: Exception) -> str:
    """What a log line may say about why a model is unavailable: a price refusal's code, else the class name only."""
    return e.code if isinstance(e, PriceRefused) else type(e).__name__


def provider_of(llm: BaseLlm) -> str:
    """The provider a spend row names for `llm`: an OpenAI-compatible model by its base URL (openrouter, nvidia, else
    openai); anything else is Gemini — the native class, and recorded replays (0015 seeds every role on gemini)."""
    if isinstance(llm, OpenAILlm):
        return next((name for name, p in PROVIDERS.items() if p.base_url is not None and p.base_url == llm.base_url), "openai")
    return "gemini"
