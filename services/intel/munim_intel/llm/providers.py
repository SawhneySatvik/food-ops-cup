"""Provider registry (R36): Gemini via ADK's native class; OpenAI, OpenRouter and NVIDIA via ADK's OpenAILlm
(base URL + key). The operator picks provider + model per role in `platform.model_role`.

Never hand ADK a model *string*: its registry resolves `openai/...` to LiteLlm (banned) and `Gemini()` defaults
to a gemini-2.5 id. Always an explicit BaseLlm instance with its model id set, checked before and after build.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from google.adk.integrations.openai import OpenAILlm
from google.adk.models import BaseLlm
from google.adk.models.google_llm import Gemini

from munim_intel.config import Config, ProviderKeyName
from munim_intel.contracts_gen.models import PlatformModelRoleRow

# Same rule as platform.model_role's CHECK (0002): any id containing gemini-2.5, any provider, any case.
_RETIRED = re.compile(r"gemini-2\.5", re.IGNORECASE)


class RetiredModelRefused(Exception):
    def __init__(self, model_id: str) -> None:
        super().__init__(f"model {model_id!r} is a gemini-2.5 model (retires 20 Oct 2026; project rule 13)")


class ProviderUnavailable(Exception):
    """A provider that cannot run here (no key). Live callers skip it loudly; it never falls back silently."""


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


def refuse_retired(model_id: str) -> None:
    if _RETIRED.search(model_id):
        raise RetiredModelRefused(model_id)


def build_live_llm(row: PlatformModelRoleRow, cfg: Config) -> BaseLlm:
    refuse_retired(row.model_id)
    provider = PROVIDERS.get(row.provider)
    if provider is None:
        raise ProviderUnavailable(f"unknown provider {row.provider!r}")
    if provider.key_name is None:
        raise ProviderUnavailable(f"{row.provider}: no API key name in .env.example — skipped")
    key = cfg.provider_key(provider.key_name)
    if key is None:
        raise ProviderUnavailable(f"{row.provider}: {provider.key_name} is not set — skipped")
    llm: BaseLlm
    if row.provider == "gemini":
        llm = Gemini(model=row.model_id, client_kwargs={"api_key": key})
    else:
        llm = OpenAILlm(model=row.model_id, api_key=key, base_url=provider.base_url)
    refuse_retired(llm.model)
    return llm
