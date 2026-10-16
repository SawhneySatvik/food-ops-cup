"""MunimPlugin: the one ADK plugin, covering all 14 BasePlugin callbacks (ADR-014 §10; exact names — gotcha 4).

Every Runner of a run gets a MunimPlugin over the same RunState, so budget, taint and the trace sequence are
per run, not per Runner. Each callback counts itself in `RunState.fired`; the fired gate reads the count, so a
misspelt hook (never called by ADK) shows up as 0.

What reaches a trace: kinds, actors, agent and registered tool names, outcomes, exception class names (label-safe:
buffer.error_label — ADK's `_ResourceExhaustedError` for a 429 starts with an underscore), and in live mode
the path that served each model call (`route` {model_path}: live / recorded-fallback / abstained, T-125). Never the
member's message, model text, tool arguments or results, or an exception's message (rule 8; ADR-014 §6.4 rule 5).

Spend (W3 close ruling, trace/spend.py): every provider call of the context is one row in the run's spend buffer —
after_model_callback with the provider's usage (or a request-size estimate when none is reported), on_model_error_callback
with the estimate (a failed or timed-out call may still be billed). A response a callback made up (the budget fallback,
the assembler's cap) never reaches the provider and is not charged: ADK skips after_model for it. The buffer flushes with
the traces (after_run, on_run_error, and run_agent's `finally`).

Not here yet: the §5.3 model retry ladder (cheaper role, then template) — on_model_error traces, charges and lets the
error propagate.
"""

from __future__ import annotations

import typing
from typing import Any

from google.adk.agents import BaseAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import InvocationContext
from google.adk.events import Event
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.function_tool import FunctionTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types
from pydantic import BaseModel, ConfigDict, ValidationError, create_model

from munim_intel.runtime.state import ACTOR, RunState, check_actor
from munim_intel.trace.buffer import Payload, error_label
from munim_intel.trace.served import served_by
from munim_intel.trace.spend import Usage, estimate_input_tokens

#: Tools whose results carry untrusted text into the context (ADR-014 §6.4 rule 2).
UNTRUSTED_READS = frozenset({"search", "wiki_read"})
#: §5.3, verbatim.
TAINT_REFUSAL = "Drafts are unavailable after reading untrusted text in this run."
#: What the model step returns once the budget is spent (rule 11: degrade to a template, never an error).
BUDGET_FALLBACK = "cannot verify"


def _gated(tool: str) -> bool:
    return tool.startswith("propose_") or tool == "request_quotes"


def _tool_label(tool: BaseTool) -> str:
    # ADK answers a hallucinated tool name with a bare BaseTool stand-in (flows/llm_flows/tools/_caller.py):
    # that name is model text, so it is never traced.
    return "unknown_tool" if type(tool) is BaseTool else tool.name


def _carries_taint(result: Any) -> bool:
    """A BranchReport (or a list of them, as fan_out returns) with `tainted: true` taints the run (B1)."""
    if isinstance(result, dict):
        return result.get("tainted") is True or any(_carries_taint(v) for v in result.values() if isinstance(v, list))
    if isinstance(result, list):
        return any(_carries_taint(v) for v in result)
    return False


def _args_model(tool: FunctionTool) -> type[BaseModel]:
    hints = typing.get_type_hints(tool.func)
    hints.pop("return", None)
    hints.pop("tool_context", None)
    fields: dict[str, Any] = {n: (t, ...) for n, t in hints.items()}
    return create_model(f"{tool.name}_args", __config__=ConfigDict(extra="forbid"), **fields)


def _invalid_args(tool: BaseTool, args: dict[str, Any]) -> str | None:
    """An actionable error (≤ 300 chars: path and expected form, no input values), or None when the args are valid."""
    # Generated tools (T-080) check their own model-facing schema; duck-typed so trace/ need not import tools/.
    validate = getattr(tool, "validate_args", None)
    if callable(validate):
        problem: str | None = validate(args)
        return problem
    if not isinstance(tool, FunctionTool):
        return None
    try:
        _args_model(tool).model_validate(args)
    except ValidationError as e:
        problems = "; ".join(f"{'.'.join(str(p) for p in err['loc']) or '(args)'}: {err['type']}" for err in e.errors())
        return f"invalid arguments for {tool.name}: {problems}. Call it again with corrected arguments."[:300]
    return None


class MunimPlugin(BasePlugin):
    def __init__(self, state: RunState) -> None:
        super().__init__(name="munim")
        self.state = state
        #: ADK function-call id -> its tool_call trace id (the tool_result's parent).
        self._calls: dict[str, str] = {}
        #: Calls this plugin answered in before_tool. ADK still runs after_tool on them; their result is already traced.
        self._answered: set[str] = set()
        #: The current model call's input estimate (a context's calls are sequential), for a call that reports no usage.
        self._estimate = 0

    def _fire(self, callback: str) -> None:
        self.state.fired[callback] += 1

    def _actor(self, tool: BaseTool | None = None) -> str:
        actor = ACTOR.get()
        pack = self.state.tool_pack.get(tool.name) if tool is not None else None
        return check_actor(f"specialist:{pack}") if pack and actor == "manager" else actor

    async def _trace(self, kind: str, payload: Payload, *, tool: BaseTool | None = None, parent: str | None = None) -> str:
        return await self.state.traces.append(kind, self._actor(tool), payload, parent_id=parent)

    async def _refuse(self, tool: BaseTool, ctx: ToolContext, reason: str, error: str) -> dict[str, Any]:
        self._answered.add(ctx.function_call_id or "")
        await self._tool_result(tool, ctx, {"outcome": "refused", "reason": reason})
        return {"error": error}

    async def _tool_result(self, tool: BaseTool, ctx: ToolContext, payload: Payload) -> None:
        await self._trace(
            "tool_result", {"tool": _tool_label(tool), **payload}, tool=tool, parent=self._calls.get(ctx.function_call_id or "")
        )

    # -- run ----------------------------------------------------------------------------------------------------

    async def on_user_message_callback(self, *, invocation_context: InvocationContext, user_message: types.Content) -> None:
        self._fire("on_user_message_callback")
        agent = invocation_context.agent
        await self._trace("route", {"agent": agent.name if agent is not None else "none"})

    async def before_run_callback(self, *, invocation_context: InvocationContext) -> types.Content | None:
        self._fire("before_run_callback")
        if self.state.budget.models_exhausted():
            await self._trace("abstain", {"reason": "ai_budget_cap"})
            return types.Content(role="model", parts=[types.Part(text=BUDGET_FALLBACK)])
        return None

    async def on_event_callback(self, *, invocation_context: InvocationContext, event: Event) -> None:
        self._fire("on_event_callback")
        event.custom_metadata = {**(event.custom_metadata or {}), "munim_actor": self._actor()}

    async def _flush(self) -> None:
        await self.state.traces.flush()
        if self.state.meter is not None:
            await self.state.meter.buffer.flush()

    async def after_run_callback(self, *, invocation_context: InvocationContext) -> None:
        self._fire("after_run_callback")
        await self._flush()

    async def on_run_error_callback(self, *, invocation_context: InvocationContext, error: Exception) -> None:
        # after_run_callback is skipped when the run errors (runners.py, `run_error is None`): flush here too.
        self._fire("on_run_error_callback")
        await self._trace("error", {"where": "run", "error": error_label(error)})
        await self._flush()

    # -- agent --------------------------------------------------------------------------------------------------

    async def before_agent_callback(self, *, agent: BaseAgent, callback_context: CallbackContext) -> None:
        self._fire("before_agent_callback")
        await self._trace("subagent_start", {"agent": agent.name})

    async def after_agent_callback(self, *, agent: BaseAgent, callback_context: CallbackContext) -> None:
        self._fire("after_agent_callback")
        await self._trace("subagent_end", {"agent": agent.name})

    async def on_agent_error_callback(self, *, agent: BaseAgent, callback_context: CallbackContext, error: Exception) -> None:
        self._fire("on_agent_error_callback")
        await self._trace("error", {"where": "agent", "agent": agent.name, "error": error_label(error)})

    # -- model --------------------------------------------------------------------------------------------------

    async def before_model_callback(self, *, callback_context: CallbackContext, llm_request: LlmRequest) -> LlmResponse | None:
        self._fire("before_model_callback")
        budget = self.state.budget
        # Check and count with no await between, so concurrent branches cannot both take the last call.
        if budget.models_exhausted():
            await self._trace("abstain", {"reason": "ai_budget_cap"})
            return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=BUDGET_FALLBACK)]))
        budget.model_calls += 1
        self._estimate = estimate_input_tokens(llm_request)
        return None

    async def after_model_callback(self, *, callback_context: CallbackContext, llm_response: LlmResponse) -> None:
        self._fire("after_model_callback")
        # Spend first: nothing below (a trace, its flush) may stand between a provider call and its row.
        usage = llm_response.usage_metadata
        if usage is not None:
            self.state.budget.input_tokens += usage.prompt_token_count or 0
            self.state.budget.output_tokens += usage.candidates_token_count or 0
        if self.state.meter is not None and not llm_response.partial:
            if usage is not None and usage.prompt_token_count is not None:
                # Thinking tokens are billed as output.
                out = (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0)
                self.state.meter.record(Usage(usage.prompt_token_count, out))
            else:
                self.state.meter.record(Usage(self._estimate, 0, estimated=True))
        # Live mode (T-125): which path served the call, a label (trace/served.py). A recorded replay carries none.
        path = served_by(llm_response)
        if path is not None and not llm_response.partial:
            await self._trace("route", {"model_path": path})

    async def on_model_error_callback(self, *, callback_context: CallbackContext, llm_request: LlmRequest, error: Exception) -> None:
        self._fire("on_model_error_callback")
        # Spend first (a failed or rate-limited call may still be billed), then the traces.
        if self.state.meter is not None:
            self.state.meter.record(Usage(self._estimate, 0, estimated=True))
        path = served_by(error)
        if path is not None:
            await self._trace("route", {"model_path": path})
        await self._trace("error", {"where": "model", "error": error_label(error)})

    # -- tool ---------------------------------------------------------------------------------------------------

    async def before_tool_callback(self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext) -> dict[str, Any] | None:
        self._fire("before_tool_callback")
        name = _tool_label(tool)
        state = self.state
        # Set before any await: once this call is under way its untrusted result can reach the context.
        if name in UNTRUSTED_READS:
            state.tainted = True
        self._calls[tool_context.function_call_id or ""] = await self._trace("tool_call", {"tool": name}, tool=tool)
        if state.tainted and _gated(name):
            return await self._refuse(tool, tool_context, "tainted_run", TAINT_REFUSAL)
        if state.invalid_args[name] >= 2:
            return await self._refuse(tool, tool_context, "tool_disabled", f"{name} is disabled for this run after invalid arguments.")
        state.budget.tool_calls += 1
        if state.budget.tool_calls > state.budget.max_tool_calls:
            return await self._refuse(tool, tool_context, "tool_cap", "The tool-call limit for this run is reached.")
        problem = _invalid_args(tool, tool_args)
        if problem is not None:
            state.invalid_args[name] += 1
            return await self._refuse(tool, tool_context, "invalid_args", problem)
        return None

    async def after_tool_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext, result: dict[str, Any]
    ) -> None:
        self._fire("after_tool_callback")
        if _carries_taint(result):
            self.state.tainted = True
        if (tool_context.function_call_id or "") not in self._answered:
            await self._tool_result(tool, tool_context, {"outcome": "ok"})

    async def on_tool_error_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext, error: Exception
    ) -> None:
        self._fire("on_tool_error_callback")
        await self._tool_result(tool, tool_context, {"outcome": "error", "error": error_label(error)})
