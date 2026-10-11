"""Gate: gemini-2.5 refused on every path; provider registry builds explicit ADK instances; recorded mode never
asks for a provider. Constructing a client makes no network call (the socket guard is on)."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import pytest
from google.adk.agents import LlmAgent
from google.adk.integrations.openai import OpenAILlm
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from conftest import GEMINI_KEY
from munim_intel.config import Config, ConfigError, load_config
from munim_intel.contracts_gen.models import PlatformModelRoleRow, PlatformModelRoles
from munim_intel.decide.mimic import LlmMimic
from munim_intel.decide.questions import ROUTE_INTENT
from munim_intel.llm import llm_for_role
from munim_intel.llm.providers import (
    ProviderUnavailable,
    RetiredModelRefused,
    TimedGemini,
    TimedOpenAILlm,
    build_live_llm,
    refuse_retired,
)
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.runner import RunFailed, run_agent


def vid(n: int) -> str:
    return f"01920000-0000-7000-8000-{n:012x}"


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


# -- live call timeouts (W3 close ruling) ------------------------------------------------------------------------------


def _slow(seconds: float) -> Any:
    """A provider that answers after `seconds` (in place of the network: the socket guard stays on)."""

    async def generate(self: Any, llm_request: Any, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        await asyncio.sleep(seconds)
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="A")]))

    return generate


def test_each_role_gets_its_timeout_and_an_operator_may_override_it(tmp_path: Path) -> None:
    cfg = load_config(env={"GEMINI_API_KEY": GEMINI_KEY, "OPENROUTER_API_KEY": "or-test-key-0002"}, run_dir=tmp_path)
    # Hand list (the ruling): router 20 s, narrate 30, reason 60, vision 90, extract 30, embed 15.
    assert cfg.model_timeouts_s == {"router": 20.0, "narrate": 30.0, "reason": 60.0, "vision": 90.0, "extract": 30.0, "embed": 15.0}
    g = build_live_llm(row("gemini", "gemini-3.8-flash", "reason"), cfg)
    o = build_live_llm(row("openrouter", "some/model", "narrate"), cfg)
    assert isinstance(g, TimedGemini) and isinstance(g, Gemini) and g.timeout_s == 60.0
    assert isinstance(o, TimedOpenAILlm) and isinstance(o, OpenAILlm) and o.timeout_s == 30.0  # mimic's request shape holds
    over = load_config(env={"GEMINI_API_KEY": GEMINI_KEY, "MUNIM_MODEL_TIMEOUT_REASON_S": "7.5"}, run_dir=tmp_path)
    assert build_live_llm(row("gemini", "gemini-3.8-flash", "reason"), over).timeout_s == 7.5  # type: ignore[attr-defined]
    for bad in ("soon", "0", "-1", "601"):
        with pytest.raises(ConfigError):
            load_config(env={"MUNIM_MODEL_TIMEOUT_ROUTER_S": bad}, run_dir=tmp_path)


def test_a_live_call_past_its_timeout_fails_like_a_provider_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = load_config(env={"GEMINI_API_KEY": GEMINI_KEY, "MUNIM_MODEL_TIMEOUT_REASON_S": "0.05"}, run_dir=tmp_path)
    monkeypatch.setattr(Gemini, "generate_content_async", _slow(5))
    llm = build_live_llm(row("gemini", "gemini-3.8-flash", "reason"), cfg)
    agent = LlmAgent(name="munim", model=llm, instruction="Answer.")
    ctx = RunContext(vid(1), vid(2), ("*",), "ask", "manager", 2_000_000_000, "h.p.s")
    started = time.monotonic()
    with pytest.raises(RunFailed) as e:
        asyncio.run(run_agent(agent, ctx, "hello", cfg))
    assert e.value.kind == "TimeoutError" and time.monotonic() - started < 3
    # The DecisionModel: a timed-out router call is adapter_error (the ask falls back to explain), never a hang.
    rcfg = load_config(env={"GEMINI_API_KEY": GEMINI_KEY, "MUNIM_MODEL_TIMEOUT_ROUTER_S": "0.05"}, run_dir=tmp_path)
    router = build_live_llm(row("gemini", "gemini-3.5-flash-lite", "router"), rcfg)
    [d] = asyncio.run(LlmMimic(router).decide(ctx, {"question": "why", "outlet_kinds": ("restaurant",), "country": "IN"}, [ROUTE_INTENT]))
    assert d.abstained and d.reason == "adapter_error" and len(d.call_usage) == 1 and d.call_usage[0].estimated


def test_paired_a_live_call_within_its_timeout_answers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = load_config(env={"GEMINI_API_KEY": GEMINI_KEY}, run_dir=tmp_path)
    monkeypatch.setattr(Gemini, "generate_content_async", _slow(0.01))
    llm = build_live_llm(row("gemini", "gemini-3.8-flash", "reason"), cfg)
    agent = LlmAgent(name="munim", model=llm, instruction="Answer.")
    ctx = RunContext(vid(1), vid(2), ("*",), "ask", "manager", 2_000_000_000, "h.p.s")
    events = asyncio.run(run_agent(agent, ctx, "hello", cfg))
    assert any(p.text == "A" for e in events if e.content for p in e.content.parts or [])
