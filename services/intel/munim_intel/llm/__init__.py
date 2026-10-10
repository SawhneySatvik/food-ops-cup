"""Role -> model (R36). Recorded mode never consults a provider; live mode reads platform.model_role from core."""

from __future__ import annotations

from typing import Literal, Protocol

from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.contracts_gen.models import PlatformModelRoles
from munim_intel.llm.providers import ProviderUnavailable, build_live_llm
from munim_intel.llm.recorded import RecordedLlm

ModelRoleName = Literal["router", "reason", "extract", "narrate", "vision", "embed"]


class ModelRoleSource(Protocol):
    async def model_roles(self) -> PlatformModelRoles: ...


async def llm_for_role(role: ModelRoleName, cfg: Config, roles: ModelRoleSource) -> BaseLlm:
    if cfg.model_mode == "recorded":
        return RecordedLlm(model=f"recorded/{role}")
    row = next((r for r in (await roles.model_roles()).items if r.role == role), None)
    if row is None:
        raise ProviderUnavailable(f"no platform.model_role row for {role!r}")
    return build_live_llm(row, cfg)
