"""One ADK run per request: a fresh InMemorySessionService, the session created before the run (gotcha 5),
nothing persisted (no DatabaseSessionService — gotcha 25, R25). Errors leave as RunFailed with redacted text
and no exception chain, so a provider error quoting a key cannot leak through a cause or a traceback.

With a RunState (T-042) the Runner carries a MunimPlugin over it, and the run's traces and spend rows are flushed in
`finally` as well: on_run_error_callback sees `Exception` only, so a cancelled run would otherwise lose them. A fan-out branch
Runner (T-053) passes its own RunState — its own budget and taint flag over the run's shared HandleTable and TraceBuffer —
and its own actor label (`branch:<pack>`); its taint reaches the Manager through `BranchReport.tainted`.
"""

from __future__ import annotations

from google.adk.agents import BaseAgent
from google.adk.apps import App
from google.adk.events import Event
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from munim_intel.config import Config
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.state import ACTOR, RunState, check_actor
from munim_intel.trace.plugin import MunimPlugin

APP_NAME = "munim_intel"


class RunFailed(Exception):
    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(f"{kind}: {detail}")
        #: The original exception's class name, e.g. RecordedFixtureMissing.
        self.kind = kind


async def run_agent(
    agent: BaseAgent, ctx: RunContext, message: str, cfg: Config, *, state: RunState | None = None, actor: str = "manager"
) -> list[Event]:
    check_actor(actor)
    sessions = InMemorySessionService()
    plugins = [] if state is None else [MunimPlugin(state)]
    runner = Runner(app=App(name=APP_NAME, root_agent=agent, plugins=plugins), session_service=sessions)
    events: list[Event] = []
    failure: RunFailed | None = None
    actor_token = ACTOR.set(actor)
    try:
        session = await sessions.create_session(app_name=APP_NAME, user_id=ctx.actor, session_id=ctx.run_id)
        content = types.Content(role="user", parts=[types.Part(text=message)])
        async for event in runner.run_async(user_id=ctx.actor, session_id=session.id, new_message=content):
            events.append(event)
    except Exception as e:  # noqa: BLE001 — every failure is re-raised below, redacted and unchained
        failure = RunFailed(type(e).__name__, cfg.redact(str(e)))
    finally:
        await runner.close()
        if state is not None:
            # Each flush is tried even when the other fails: spend that core never sees is a cap that never moves.
            for flush in [state.traces.flush, *([state.meter.buffer.flush] if state.meter is not None else [])]:
                try:
                    await flush()
                except Exception as e:  # noqa: BLE001 — a run that already failed keeps its own failure
                    failure = failure or RunFailed(type(e).__name__, cfg.redact(str(e)))
        ACTOR.reset(actor_token)
    if failure is not None:
        raise failure
    return events
