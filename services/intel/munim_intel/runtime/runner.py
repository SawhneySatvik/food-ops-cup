"""One ADK run per request: a fresh InMemorySessionService, the session created before the run (gotcha 5),
nothing persisted (no DatabaseSessionService — gotcha 25, R25). Errors leave as RunFailed with redacted text
and no exception chain, so a provider error quoting a key cannot leak through a cause or a traceback.
"""

from __future__ import annotations

from google.adk.agents import BaseAgent
from google.adk.events import Event
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from munim_intel.config import Config
from munim_intel.runtime.context import RunContext

APP_NAME = "munim_intel"


class RunFailed(Exception):
    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(f"{kind}: {detail}")
        #: The original exception's class name, e.g. RecordedFixtureMissing.
        self.kind = kind


async def run_agent(agent: BaseAgent, ctx: RunContext, message: str, cfg: Config) -> list[Event]:
    sessions = InMemorySessionService()
    runner = Runner(app_name=APP_NAME, agent=agent, session_service=sessions)
    events: list[Event] = []
    failure: RunFailed | None = None
    try:
        session = await sessions.create_session(app_name=APP_NAME, user_id=ctx.actor, session_id=ctx.run_id)
        content = types.Content(role="user", parts=[types.Part(text=message)])
        async for event in runner.run_async(user_id=ctx.actor, session_id=session.id, new_message=content):
            events.append(event)
    except Exception as e:  # noqa: BLE001 — every failure is re-raised below, redacted and unchained
        failure = RunFailed(type(e).__name__, cfg.redact(str(e)))
    finally:
        await runner.close()
    if failure is not None:
        raise failure
    return events
