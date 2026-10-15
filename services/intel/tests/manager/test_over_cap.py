"""T-127 (ledger R58; T-125's open item 1): over the month's AI cap is not AI switched off.

The run-frame carries the typed kill switch on its own (`ai_enabled`). With AI switched off a run gets no AI answer at all — not
a live one and not a recorded one. Over the R47 cap (AI on, budget level `hard`) a live run builds its models `capped`: no call
reaches the provider, and each is served from the recorded fixture of that exact call or abstains (T-125). No budget for the
month (R47 D2) stays declined, and recorded mode is unchanged: every gate replays as before.

Offline: recorded fixtures only, the provider planted in place of the network (test_live_fallback.py's Provider), a fake key.
The dangerous case is AI off with a fixture present: the Manager's curated question below has a fixture for every call, and
the ask must still store `model_blocked` with 0 provider calls, 0 fixture reads and no model built.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from google.adk.models import BaseLlm
from test_live_fallback import RECORDED_ANSWER, ROLES, Provider, ask_req, failing, live_cfg, paths

from manager_kit import CTX, DM_FIXTURES, LLM_FIXTURES, LOOKUP_FINANCE, FakeCore, frame, kit_cfg
from munim_intel.app import watch_narrator
from munim_intel.config import Config
from munim_intel.contracts_gen.models import InternalRunFrameResponse
from munim_intel.decide.mimic import LlmMimic
from munim_intel.llm import llm_for_role, over_cap
from munim_intel.llm.providers import TimedGemini
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.manager.ask import Models, ModelsFactory, answer_ask, default_models
from munim_intel.negotiate.route import default_models as negotiate_models
from munim_intel.watch.frame import frame_from_run_frame
from munim_intel.watch.pipeline import WatchRun


def frame_at(ai_enabled: bool, level: str | None) -> InternalRunFrameResponse:
    """A run-frame as core derives it (frame.ts): narration `model` only with AI on and budget left; no budget → null."""
    budget = None
    if level is not None:
        left = 0 if level == "hard" else 400_000
        budget = {
            "month": "2026-10-01",
            "currency": "INR",
            "owner_cap_minor": None,
            "operator_limit_minor": 500_000,
            "effective_cap_minor": 500_000,
            "spent_minor": 500_000 - left,
            "hard_left_minor": left,
            "level": level,
        }
    body = frame().model_dump(mode="json")
    narration = "model" if ai_enabled and level == "ok" else "template"
    return InternalRunFrameResponse.model_validate({**body, "budget": budget, "narration": narration, "ai_enabled": ai_enabled})


def kit_models(cfg: Config, built: list[bool]) -> ModelsFactory:
    """The production factory's shape (manager/ask.py default_models), each role's fallback the kit's recorded fixtures."""

    async def build(client: Any, currency: str, capped: bool = False) -> Models:
        built.append(capped)
        router = await llm_for_role("router", cfg, client, currency=currency, fallback_dir=DM_FIXTURES, capped=capped)
        reason = await llm_for_role("reason", cfg, client, currency=currency, fallback_dir=LLM_FIXTURES, capped=capped)
        return Models(LlmMimic(router), reason)

    return build


#: (case, ai_enabled, budget level, mode, expected): `served` = the recorded answer, no provider call; `blocked` = model_blocked.
CASES = [
    ("AI off, over the cap", False, "hard", "live", "blocked"),
    ("AI off, budget left", False, "ok", "live", "blocked"),
    ("AI on, no budget this month", True, None, "live", "blocked"),
    ("AI on, over the cap, recorded mode", True, "hard", "recorded", "blocked"),
    ("AI on, over the cap", True, "hard", "live", "served"),
]


@pytest.mark.parametrize(("case", "ai_enabled", "level", "mode", "want"), CASES, ids=[c[0] for c in CASES])
def test_an_ask_over_the_cap_is_served_from_its_fixture_and_never_with_ai_off(
    case: str, ai_enabled: bool, level: str | None, mode: str, want: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = Provider(monkeypatch, failing("rate_limited"))
    cfg = live_cfg(tmp_path) if mode == "live" else kit_cfg()
    core = FakeCore(frame_at(ai_enabled, level), model_roles=ROLES)
    built: list[bool] = []
    reads = RecordedLlm.calls

    async def go() -> None:
        client = core.client()
        try:
            await answer_ask(CTX, ask_req(LOOKUP_FINANCE, "finance"), core.run_frame, client, cfg, kit_models(cfg, built))
        finally:
            await client.aclose()

    asyncio.run(go())
    [answer] = core.answers
    env = answer["envelope"]
    assert provider.calls == [], f"{case}: no call reaches the provider"
    if want == "blocked":
        assert (env["abstained"], env["reason_code"], env["segments"]) == (True, "model_blocked", []), case
        assert built == [] and RecordedLlm.calls == reads and core.spend == [], f"{case}: no model is built and no fixture read"
    else:
        assert env["abstained"] is False and [s["text"] for s in env["segments"]] == [RECORDED_ANSWER]
        assert built == [True] and RecordedLlm.calls > reads
        assert paths(core) == ("recorded-fallback", ["recorded-fallback", "recorded-fallback"])
        assert [r["amount_minor"] for r in core.spend] == [0, 0, 0], "over the cap nothing is charged"


def test_over_cap_needs_live_mode_ai_on_and_a_spent_budget() -> None:
    live = Config({"MUNIM_MODEL_MODE": "live"}, {}, Path("."))
    assert over_cap(live, True, "hard") is True
    for cfg, ai, level in ((live, False, "hard"), (live, None, "hard"), (live, True, "ok"), (live, True, None), (kit_cfg(), True, "hard")):
        assert over_cap(cfg, ai, level) is False, (cfg.model_mode, ai, level)


# -- the watcher's and the brief's narrate model (app.py watch_narrator), and the watcher's own gate --------------------


@pytest.mark.parametrize(
    ("ai_enabled", "level", "mode", "want"),
    [
        (False, "hard", "live", None),
        (False, "ok", "live", None),
        (True, None, "live", None),
        (True, "hard", "recorded", None),
        (True, "hard", "live", "capped"),
        (True, "ok", "live", "live"),
    ],
)
def test_a_watcher_narrates_over_the_cap_only_capped_and_never_with_ai_off(
    ai_enabled: bool, level: str | None, mode: str, want: str | None, tmp_path: Path
) -> None:
    cfg = live_cfg(tmp_path) if mode == "live" else kit_cfg()
    w = frame_from_run_frame(frame_at(ai_enabled, level).model_dump(mode="json"))
    # The kit's roles plus `narrate`, priced in INR like the others.
    core = FakeCore(model_roles={"items": [*ROLES["items"], {**ROLES["items"][1], "role": "narrate"}]})

    async def go() -> BaseLlm | None:
        client = core.client()
        try:
            return await watch_narrator(cfg, client, w)
        finally:
            await client.aclose()

    llm = asyncio.run(go())
    if want is None:
        assert llm is None
    else:
        assert isinstance(llm, TimedGemini) and llm.capped is (want == "capped") and llm.fallback is not None
    run = WatchRun(CTX, core.client(), w, cfg, llm=RecordedLlm(model="recorded/narrate"))
    assert (run.llm is not None) is (want is not None), "the watcher keeps a model only where the narrator builds one"


def test_the_production_factories_build_every_model_capped_over_the_cap(tmp_path: Path) -> None:
    """manager/ask.py and negotiate/route.py's default_models hand `capped` to every role they build (the router included), so
    over the cap no role reaches the provider; under it none is capped."""
    roles = {"items": [*ROLES["items"], {**ROLES["items"][1], "role": "extract"}]}
    core = FakeCore(model_roles=roles)
    cfg = live_cfg(tmp_path)

    async def build(capped: bool) -> list[Any]:
        client = core.client()
        try:
            m = await default_models(cfg)(client, "INR", capped)
            n = await negotiate_models(cfg)(client, "INR", capped)
        finally:
            await client.aclose()
        return [m.decide._llm, m.reason, *n]  # type: ignore[attr-defined]  # noqa: SLF001

    for capped in (True, False):
        built = asyncio.run(build(capped))
        assert [type(x).__name__ for x in built] == ["TimedGemini"] * 4
        assert [x.capped for x in built] == [capped] * 4, capped
