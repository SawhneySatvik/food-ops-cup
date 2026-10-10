"""Gate: gemini-2.5 refused on every path; provider registry builds explicit ADK instances; recorded mode never
asks for a provider. Constructing a client makes no network call (the socket guard is on)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from google.adk.integrations.openai import OpenAILlm
from google.adk.models.google_llm import Gemini

from conftest import GEMINI_KEY
from munim_intel.config import Config, load_config
from munim_intel.contracts_gen.models import PlatformModelRoleRow, PlatformModelRoles
from munim_intel.llm import llm_for_role
from munim_intel.llm.providers import ProviderUnavailable, RetiredModelRefused, build_live_llm, refuse_retired
from munim_intel.llm.recorded import RecordedLlm

ROLES_0015 = Path(__file__).resolve().parents[1] / "fixtures" / "model_roles_0015.json"


def row(provider: str, model_id: str, role: str = "router") -> PlatformModelRoleRow:
    return PlatformModelRoleRow.model_validate(
        {
            "role": role,
            "provider": provider,
            "model_id": model_id,
            "location": None,
            "probed_at": None,
            "updated_at": "2026-10-10T00:00:00Z",
        }
    )


class Roles:
    def __init__(self, roles: PlatformModelRoles | None) -> None:
        self.roles = roles
        self.calls = 0

    async def model_roles(self) -> PlatformModelRoles:
        self.calls += 1
        assert self.roles is not None, "recorded mode asked core for model roles"
        return self.roles


@pytest.mark.parametrize(
    ("provider", "model_id"),
    [
        ("gemini", "gemini-2.5-flash"),
        ("gemini", "GEMINI-2.5-PRO"),
        ("openrouter", "google/gemini-2.5-flash"),
        ("nvidia", "x/gemini-2.5-lite"),
    ],
)
def test_a_gemini_25_model_is_refused(cfg: Config, provider: str, model_id: str) -> None:
    with pytest.raises(RetiredModelRefused):
        build_live_llm(row(provider, model_id), cfg)


def test_current_models_build_explicit_instances(cfg: Config) -> None:
    gemini = build_live_llm(row("gemini", "gemini-3.5-flash-lite"), cfg)
    assert isinstance(gemini, Gemini) and gemini.model == "gemini-3.5-flash-lite"
    nvidia = row("nvidia", "meta/llama-3.3-70b-instruct")
    with pytest.raises(ProviderUnavailable, match="NVIDIA_API_KEY is not set"):
        build_live_llm(nvidia, cfg)
    routed = build_live_llm(row("openrouter", "meta-llama/llama-3.3-70b-instruct"), cfg)
    assert isinstance(routed, OpenAILlm) and routed.base_url == "https://openrouter.ai/api/v1"
    refuse_retired("gemini-3.5-flash")


def test_openai_is_skipped_loudly_without_a_key_name(cfg: Config) -> None:
    with pytest.raises(ProviderUnavailable, match="openai: no API key name"):
        build_live_llm(row("openai", "gpt-5"), cfg)


def test_recorded_mode_never_asks_for_a_provider(cfg: Config) -> None:
    roles = Roles(None)
    llm = asyncio.run(llm_for_role("router", cfg, roles))
    assert isinstance(llm, RecordedLlm) and llm.model == "recorded/router"
    assert roles.calls == 0


def test_live_mode_reads_the_role_from_core(tmp_path: Path) -> None:
    live = load_config(env={"MUNIM_MODEL_MODE": "live", "MUNIM_RUN_DIR": str(tmp_path), "GEMINI_API_KEY": GEMINI_KEY})
    roles = Roles(PlatformModelRoles.model_validate(json.loads(ROLES_0015.read_text())))
    reason = asyncio.run(llm_for_role("reason", live, roles))
    assert isinstance(reason, Gemini) and reason.model == "gemini-3.8-flash"
    assert roles.calls == 1
    retired = Roles(PlatformModelRoles(items=[row("gemini", "gemini-2.5-flash", "reason")]))
    with pytest.raises(RetiredModelRefused):
        asyncio.run(llm_for_role("reason", live, retired))
