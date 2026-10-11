"""Role -> model (R36). Recorded mode never consults a provider; live mode reads platform.model_role from core."""

from __future__ import annotations

from typing import Literal, Protocol

from google.adk.integrations.openai import OpenAILlm
from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.contracts_gen.models import PlatformModelRoles
from munim_intel.llm.providers import PROVIDERS, PriceRefused, ProviderUnavailable, build_live_llm, row_price
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.trace.price import Price

ModelRoleName = Literal["router", "reason", "extract", "narrate", "vision", "embed"]


class ModelRoleSource(Protocol):
    async def model_roles(self) -> PlatformModelRoles: ...


async def llm_for_role(role: ModelRoleName, cfg: Config, roles: ModelRoleSource, *, currency: str | None) -> BaseLlm:
    """The role's model, carrying its operator price (R47 D1). Live: refused before any call when the operator set no
    price, or a price in another currency than `currency` — the run's spend currency (`spend_currency(frame)`); None
    only for a caller that posts no spend rows. Recorded: a replay with no price (charged 0)."""
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
    return build_live_llm(row, cfg, price)


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
