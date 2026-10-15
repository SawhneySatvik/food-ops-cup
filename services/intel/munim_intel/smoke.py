"""The smoke run: one trivial agent, the echo tool, the run's context end to end. No prompts beyond this."""

from __future__ import annotations

import hashlib
from typing import Any

from google.adk.agents import LlmAgent

from munim_intel.config import Config
from munim_intel.llm import ModelRoleSource, llm_for_role
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.runtime.runner import run_agent
from munim_intel.tools import TOOLS, build_tools

INSTRUCTION = "Call the echo tool once with the user's text, then reply with the single word: done."


async def smoke_run(ctx: RunContext, cfg: Config, client: InternalClient, roles: ModelRoleSource, text: str) -> dict[str, Any]:
    """Deterministic fields only (no session, invocation or event ids, no timestamps), so a recorded run returns
    the same bytes every time. Nothing the model chose reaches the payload: tool names only if registered, the
    tool's context fields (which come from the RunContext, not the model), and model text as hashes."""
    agent = LlmAgent(
        name="smoke",
        # The probe posts no spend rows, and no recorded fixture may pass for a dead provider (no fallback, T-125).
        model=await llm_for_role("router", cfg, roles, currency=None, fallback_dir=None),
        instruction=INSTRUCTION,
        tools=build_tools(["echo"], ctx, client),
    )
    events = await run_agent(agent, ctx, text, cfg)
    parts = [p for e in events if e.content for p in e.content.parts or []]
    results = [p.function_response.response or {} for p in parts if p.function_response and p.function_response.name in TOOLS]
    final = "".join(p.text for e in events if e.is_final_response() and e.content for p in e.content.parts or [] if p.text)
    return {
        "run_id": ctx.run_id,
        "tool_calls": [p.function_call.name for p in parts if p.function_call and p.function_call.name in TOOLS],
        "tool_context": [{"run_id": r.get("run_id"), "outlet_scope": r.get("outlet_scope")} for r in results],
        "echo_text_sha256": [_sha(str(r.get("text"))) for r in results],
        "final_text_sha256": _sha(final),
    }


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()
