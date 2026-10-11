"""T-042 gates (BOARD W3 row b-42 plus the lane's taint, prose and round-trip gates). Recorded models only.

Expected values are hand values from the scripted steps in trace_harness.SCENARIOS and the ADR-014 §10 callback table,
never read back from the plugin.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Coroutine
from pathlib import Path
from typing import Any, get_args

import pytest
from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.plugins.plugin_manager import PluginCallbackName
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools.function_tool import FunctionTool
from google.genai import types
from trace_harness import (
    CTX,
    EXECUTED,
    PLANTED,
    SCENARIOS,
    Core,
    HangingLlm,
    agent,
    fan_out_then_propose,
    new_state,
    read_sales,
    recorded,
    run,
)

from munim_intel.config import Config, load_config
from munim_intel.contracts_gen.models import Events
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import Budget, RunState
from munim_intel.trace.buffer import LABEL, TraceBuffer, TraceLabelError
from munim_intel.trace.plugin import BUDGET_FALLBACK, TAINT_REFUSAL, MunimPlugin, _carries_taint, _invalid_args

#: ADR-014 §10 "The 14 MunimPlugin callbacks" (hand list).
CALLBACKS_14 = (
    "on_user_message_callback",
    "before_run_callback",
    "on_event_callback",
    "after_run_callback",
    "before_agent_callback",
    "after_agent_callback",
    "before_model_callback",
    "after_model_callback",
    "on_model_error_callback",
    "before_tool_callback",
    "after_tool_callback",
    "on_tool_error_callback",
    "on_agent_error_callback",
    "on_run_error_callback",
)


@pytest.fixture
def cfg(tmp_path: Path) -> Config:
    return load_config(env={}, run_dir=tmp_path)


@pytest.fixture(autouse=True)
def reset_executed() -> None:
    EXECUTED.clear()


def go[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def results(core: Core, tool: str) -> list[Events]:
    return [e for e in core.ordered() if e.kind == "tool_result" and _p(e, "tool") == tool]


def _p(e: Events, key: str) -> str | list[str] | None:
    v = e.payload.get(key)
    if v is None:
        return None
    return [i.root for i in v] if isinstance(v, list) else v.root


# -- (1) every callback fires; a misspelt hook is 0 -----------------------------------------------------------------


def test_the_hand_list_is_adks_14_callbacks() -> None:
    assert len(CALLBACKS_14) == 14 and set(CALLBACKS_14) == set(get_args(PluginCallbackName))


def test_every_hook_on_the_plugin_is_spelt_as_adk_calls_it() -> None:
    hooks = {n for n in vars(MunimPlugin) if n.endswith("_callback")}
    assert sorted(hooks - set(CALLBACKS_14)) == [] and sorted(set(CALLBACKS_14) - hooks) == []


@pytest.mark.fixture_miss_expected
def test_each_of_the_14_callbacks_fires_on_the_scripted_run_plus_3_planted_error_runs(cfg: Config, tmp_path: Path) -> None:
    fired: Counter[str] = Counter()
    clean = new_state(Core())
    go(run("clean", clean, cfg))
    fired.update(clean.fired)
    for name, model in (
        ("model_error", RecordedLlm(model="recorded/trace", fixtures_dir=tmp_path)),
        ("tool_error", None),
        ("unknown_tool", None),
    ):
        state = new_state(Core())
        try:
            go(run(name, state, cfg, model=model))
        except RunFailed:
            pass
        fired.update(state.fired)
    print("fired:", {n: fired[n] for n in CALLBACKS_14})
    assert [n for n in CALLBACKS_14 if fired[n] < 1] == []


# -- (2) a failed run still flushes ---------------------------------------------------------------------------------


@pytest.mark.fixture_miss_expected
def test_a_model_error_is_flushed_by_on_run_error_alone(tmp_path: Path) -> None:
    """A bare Runner (no run_agent `finally`): only on_run_error_callback can have flushed these rows."""
    core = Core()
    state = new_state(core)

    async def bare() -> None:
        sessions = InMemorySessionService()
        model = RecordedLlm(model="recorded/trace", fixtures_dir=tmp_path)  # empty: the model call raises
        runner = Runner(app=App(name="munim_intel", root_agent=agent(model), plugins=[MunimPlugin(state)]), session_service=sessions)
        await sessions.create_session(app_name="munim_intel", user_id="u", session_id="s")
        msg = types.Content(role="user", parts=[types.Part(text="PLANTEDQUESTION")])
        try:
            with pytest.raises(Exception):  # noqa: B017 — RecordedFixtureMissing, re-raised by ADK
                async for _ in runner.run_async(user_id="u", session_id="s", new_message=msg):
                    pass
        finally:
            await runner.close()

    go(bare())
    errors = [(_p(e, "where"), _p(e, "error")) for e in core.ordered() if e.kind == "error"]
    print("rows:", len(core.rows), "errors:", errors)
    assert len(core.rows) >= 1 and ("model", "RecordedFixtureMissing") in errors and ("run", "RecordedFixtureMissing") in errors
    assert state.traces.unsent == 0


def test_a_cancelled_run_is_flushed_by_the_runners_finally(cfg: Config) -> None:
    """CancelledError is not an Exception: on_run_error_callback never sees it, so only `finally` can flush."""
    core = Core()
    state = new_state(core)

    async def cancelled() -> int:
        started = asyncio.Event()
        task = asyncio.create_task(run("cancelled", state, cfg, model=HangingLlm(started=started)))
        # A run that fails before its model call must fail this test, not hang it.
        await asyncio.wait({task, asyncio.ensure_future(started.wait())}, timeout=30, return_when=asyncio.FIRST_COMPLETED)
        assert started.is_set() and not task.done()
        before = len(core.rows)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return before

    before = go(cancelled())
    print("rows before cancel:", before, "after:", len(core.rows))
    assert before == 0 and len(core.rows) >= 1 and state.traces.unsent == 0


@pytest.mark.fixture_miss_expected
def test_a_model_error_through_run_agent_fails_the_run_and_its_traces_are_in_core(cfg: Config, tmp_path: Path) -> None:
    core = Core()
    with pytest.raises(RunFailed) as failed:
        go(run("model_error", new_state(core), cfg, model=RecordedLlm(model="recorded/trace", fixtures_dir=tmp_path)))
    assert failed.value.kind == "RecordedFixtureMissing" and len(core.rows) >= 1


# -- (3) budget: stop at exactly the cap, template fallback --------------------------------------------------------


@pytest.mark.parametrize("budget", [Budget(max_model_calls=2), Budget(max_input_tokens=1000)], ids=["calls", "tokens"])
def test_the_budget_stops_at_exactly_the_cap_with_the_template(cfg: Config, budget: Budget) -> None:
    # clean needs 4 model calls; each recorded reply reports 600 input tokens. Cap 2 calls, or 1000 tokens (reached
    # by the 2nd reply): 2 calls are made either way.
    core = Core()
    state = new_state(core, budget)
    before = RecordedLlm.calls

    async def go_events() -> list[str]:
        events = await run_agent(agent(recorded()), CTX, SCENARIOS["clean"][0], cfg, state=state)
        return ["".join(p.text or "" for p in e.content.parts or []) for e in events if e.is_final_response() and e.content]

    finals = asyncio.run(go_events())
    abstains = [e for e in core.ordered() if e.kind == "abstain"]
    print("model calls:", RecordedLlm.calls - before, "final:", finals, "abstain:", [_p(e, "reason") for e in abstains])
    assert RecordedLlm.calls - before == 2 and state.budget.model_calls == 2
    assert finals == [BUDGET_FALLBACK] and [_p(e, "reason") for e in abstains] == ["ai_budget_cap"]


def test_the_default_budget_lets_the_scripted_run_finish(cfg: Config) -> None:
    core = Core()
    state = new_state(core)
    before = RecordedLlm.calls

    async def go_events() -> list[str]:
        events = await run_agent(agent(recorded()), CTX, SCENARIOS["clean"][0], cfg, state=state)
        return ["".join(p.text or "" for p in e.content.parts or []) for e in events if e.is_final_response() and e.content]

    finals = asyncio.run(go_events())
    print("model calls:", RecordedLlm.calls - before, "final is the template:", finals == [BUDGET_FALLBACK])
    # Hand count: SCENARIOS["clean"] has 4 model steps.
    assert RecordedLlm.calls - before == 4 and len(finals) == 1 and finals != [BUDGET_FALLBACK]
    assert [e for e in core.ordered() if e.kind == "abstain"] == []


# -- (4) invalid args: 1 actionable error + 1 retry = 2 tool_call traces --------------------------------------------


def test_invalid_args_give_one_actionable_error_then_the_retry_runs(cfg: Config) -> None:
    core = Core()
    go(run("clean", new_state(core), cfg))
    calls = [e for e in core.ordered() if e.kind == "tool_call" and _p(e, "tool") == "read_sales"]
    outcomes = [(_p(e, "outcome"), _p(e, "reason")) for e in results(core, "read_sales")]
    print("read_sales tool_call:", len(calls), "outcomes:", outcomes, "executed:", EXECUTED["read_sales"])
    assert len(calls) == 2 and outcomes == [("refused", "invalid_args"), ("ok", None)] and EXECUTED["read_sales"] == 1


def test_the_invalid_args_error_names_the_path_and_form_and_no_input_value() -> None:
    msg = _invalid_args(FunctionTool(read_sales), {"template": 5})
    assert msg is not None and "template: string_type" in msg and "5" not in msg and len(msg) <= 300
    assert _invalid_args(FunctionTool(read_sales), {"template": "finance.pnl"}) is None


# -- (5) taint: search then propose is refused, in one Runner and across branch Runners ---------------------------


def test_search_then_propose_in_one_runner_is_refused(cfg: Config) -> None:
    core = Core()
    state = new_state(core)
    go(run("tainted", state, cfg))
    outcomes = [(_p(e, "outcome"), _p(e, "reason")) for e in results(core, "propose_price")]
    print("tainted propose:", outcomes, "executed:", EXECUTED["propose_price"])
    assert state.tainted and outcomes == [("refused", "tainted_run")] and EXECUTED["propose_price"] == 0


def test_propose_without_search_is_accepted(cfg: Config) -> None:
    core = Core()
    state = new_state(core)
    go(run("clean", state, cfg))
    outcomes = [(_p(e, "outcome"), _p(e, "reason")) for e in results(core, "propose_price")]
    print("clean propose:", outcomes, "executed:", EXECUTED["propose_price"])
    assert not state.tainted and outcomes == [("ok", None)] and EXECUTED["propose_price"] == 1


def test_search_then_request_quotes_is_refused(cfg: Config) -> None:
    core = Core()
    go(run("tainted_quotes", new_state(core), cfg))
    outcomes = [(_p(e, "outcome"), _p(e, "reason")) for e in results(core, "request_quotes")]
    print("tainted request_quotes:", outcomes, "executed:", EXECUTED["request_quotes"])
    assert outcomes == [("refused", "tainted_run")] and EXECUTED["request_quotes"] == 0


def test_request_quotes_without_search_is_accepted(cfg: Config) -> None:
    core = Core()
    go(run("quotes", new_state(core), cfg))
    outcomes = [(_p(e, "outcome"), _p(e, "reason")) for e in results(core, "request_quotes")]
    print("clean request_quotes:", outcomes, "executed:", EXECUTED["request_quotes"])
    assert outcomes == [("ok", None)] and EXECUTED["request_quotes"] == 1


def test_a_branch_that_searched_taints_the_manager(cfg: Config) -> None:
    core = Core()
    state = new_state(core)
    go(fan_out_then_propose(state, cfg, first_branch="branch_search"))
    outcomes = [(e.actor, _p(e, "outcome"), _p(e, "reason")) for e in results(core, "propose_price")]
    print("after a tainted branch:", outcomes, "executed:", EXECUTED["propose_price"])
    assert outcomes == [("manager", "refused", "tainted_run")] and EXECUTED["propose_price"] == 0


def test_branches_that_only_read_leave_the_manager_able_to_propose(cfg: Config) -> None:
    core = Core()
    state = new_state(core)
    go(fan_out_then_propose(state, cfg, first_branch="branch_read"))
    outcomes = [(e.actor, _p(e, "outcome")) for e in results(core, "propose_price")]
    print("after clean branches:", outcomes, "executed:", EXECUTED["propose_price"])
    assert outcomes == [("manager", "ok")] and EXECUTED["propose_price"] == 1


def test_the_refusal_text_is_the_fixed_one() -> None:
    assert TAINT_REFUSAL == "Drafts are unavailable after reading untrusted text in this run."


def test_a_tainted_branch_report_taints_the_run() -> None:
    assert _carries_taint({"reports": [{"skill": "customers", "tainted": False}, {"skill": "finance", "tainted": True}]})
    assert not _carries_taint({"reports": [{"skill": "customers", "tainted": False}]})


# -- (6) 4 concurrent branches x 60 events -> seq 1..240 gapless ----------------------------------------------------


def test_four_concurrent_branches_of_60_events_are_seq_1_to_240_gapless() -> None:
    core = Core(latency_s=0.001)

    async def branches() -> None:
        buf = TraceBuffer(core.client().write_traces)

        async def branch(pack: str) -> None:
            for i in range(60):
                await buf.append("tool_call", f"branch:{pack}", {"tool": "read_sales", "i": str(i)})
                await asyncio.sleep(0)

        await asyncio.gather(*(branch(p) for p in ("finance", "kitchen", "people", "customers")))
        await buf.flush()

    asyncio.run(branches())
    seqs = sorted(core.rows)
    print("rows:", len(seqs), "statuses:", Counter(core.statuses), "batches:", core.batch_sizes)
    assert seqs == list(range(1, 241)) and len({e.id.root for e in core.rows.values()}) == 240
    assert all(s == 201 for s in core.statuses) and Counter(e.actor for e in core.rows.values()) == {
        "branch:finance": 60,
        "branch:kitchen": 60,
        "branch:people": 60,
        "branch:customers": 60,
    }


def test_a_flush_is_capped_at_500_events_per_batch() -> None:
    core = Core()

    async def many() -> None:
        buf = TraceBuffer(core.client().write_traces, flush_every=10_000)
        for _ in range(1200):
            await buf.append("tool_call", "manager", {"tool": "read_sales"})
        await buf.flush()

    asyncio.run(many())
    assert core.batch_sizes == [500, 500, 200] and sorted(core.rows) == list(range(1, 1201))


def test_a_retried_flush_after_a_refused_or_lost_response_is_gapless_and_inserts_nothing_twice() -> None:
    core = Core(fail=("503", "lost"))

    async def flaky() -> None:
        buf = TraceBuffer(core.client().write_traces, flush_every=50)
        for _ in range(120):  # mid-run flushes at 50 (503: kept) and 100 (stored, response lost: kept)
            await buf.append("tool_call", "manager", {"tool": "read_sales"})
        await buf.flush()  # re-sends 1..120; core skips 1..100, inserts 101..120

    asyncio.run(flaky())
    print("statuses:", core.statuses)
    assert core.statuses == [503, 503, 201] and sorted(core.rows) == list(range(1, 121))


# -- (7) every row of a skill-bearing run carries specialist:<pack> or manager -------------------------------------


def test_every_row_of_a_skill_bearing_run_carries_its_specialist_or_manager(cfg: Config) -> None:
    core = Core()
    state = new_state(core)
    state.tool_pack.update({"read_sales": "finance", "propose_price": "finance"})
    go(run("clean", state, cfg))
    actors = Counter(e.actor for e in core.ordered())
    print("actors:", dict(actors))
    # Hand count from SCENARIOS["clean"]: 3 finance tool calls, each with 1 tool_call + 1 tool_result row.
    assert actors["specialist:finance"] == 6 and actors["manager"] >= 1
    assert actors["specialist:finance"] + actors["manager"] == len(core.rows)


def test_branch_rows_carry_their_branch_label(cfg: Config) -> None:
    core = Core()
    go(fan_out_then_propose(new_state(core), cfg, first_branch="branch_search"))
    actors = Counter(e.actor for e in core.ordered())
    print("actors:", dict(actors))
    assert actors["branch:customers"] >= 1 and actors["branch:finance"] >= 1 and actors["manager"] >= 1
    assert sum(actors.values()) == len(core.rows)


def test_an_unknown_actor_label_is_refused(cfg: Config) -> None:
    with pytest.raises(ValueError):
        go(
            run_agent(
                LlmAgent(name="munim", model=recorded(), instruction="x"), CTX, "x", cfg, state=new_state(Core()), actor="specialist:bank"
            )
        )


# -- no prose in any payload ----------------------------------------------------------------------------------------


@pytest.mark.fixture_miss_expected
def test_no_payload_of_any_scripted_run_carries_planted_text(cfg: Config, tmp_path: Path) -> None:
    rows: list[Events] = []
    for name, model in (
        ("clean", None),
        ("tainted", None),
        ("unknown_tool", None),
        ("tool_error", None),
        ("model_error", RecordedLlm(model="recorded/trace", fixtures_dir=tmp_path)),
    ):
        core = Core()
        try:
            go(run(name, new_state(core), cfg, model=model))
        except RunFailed:
            pass
        rows += core.ordered()
    core = Core()
    go(fan_out_then_propose(new_state(core), cfg, first_branch="branch_search"))
    rows += core.ordered()
    values = [v for e in rows for x in e.payload.values() for v in ([i.root for i in x] if isinstance(x, list) else [x.root])]
    leaks = [v for v in values if any(p.lower() in v.lower() for p in PLANTED)]
    not_labels = [v for v in values if not LABEL.match(v)]
    print("rows:", len(rows), "values:", len(values), "leaks:", leaks, "not labels:", not_labels)
    assert len(rows) >= 30 and leaks == [] and not_labels == []
    assert "unknown_tool" in values  # the hallucinated tool name is replaced, not traced


@pytest.mark.parametrize("value", ["two words", "PLANTEDQUESTION why did margin move?", "line\nbreak", "x" * 201, ""])
def test_a_prose_payload_is_refused_naming_the_key_only(value: str) -> None:
    buf = TraceBuffer(Core().client().write_traces)
    with pytest.raises(TraceLabelError) as refused:
        asyncio.run(buf.append("route", "manager", {"agent": value}))
    assert "agent" in str(refused.value) and (value == "" or value not in str(refused.value))
    assert buf.events == []


def test_a_label_payload_is_accepted() -> None:
    buf = TraceBuffer(Core().client().write_traces)
    asyncio.run(buf.append("route", "manager", {"agent": "munim", "tools": ["read_sales", "finance.pnl"]}))
    assert len(buf.events) == 1


# -- round-trip to core traces:batch ------------------------------------------------------------------------------


def test_a_runs_batches_round_trip_to_the_recorded_core_gapless(cfg: Config) -> None:
    """Every body parses with the generated `InternalTracesBatchRequest` and core's acceptance rules take it whole."""
    core = Core()
    state = RunState(traces=TraceBuffer(core.client().write_traces, flush_every=5), budget=Budget())
    go(run("clean", state, cfg))
    print("rows:", len(core.rows), "statuses:", core.statuses, "batches:", core.batch_sizes)
    # Hand count from SCENARIOS["clean"]: route, subagent_start, 3 tool calls x (tool_call + tool_result), subagent_end.
    assert sorted(core.rows) == list(range(1, 10)) and len(state.traces.events) == 9
    assert all(s == 201 for s in core.statuses) and len(core.statuses) >= 2
