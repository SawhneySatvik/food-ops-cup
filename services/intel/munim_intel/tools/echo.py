"""Smoke-only tool: proves a tool sees the run's context without the model ever passing it."""

from __future__ import annotations

from typing import TypedDict

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.function_tool import FunctionTool

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools import register


class EchoResult(TypedDict):
    text: str
    run_id: str
    outlet_scope: list[str]


@register("echo")
def echo_tool(ctx: RunContext, client: InternalClient) -> BaseTool:
    def echo(text: str) -> EchoResult:
        """Echo the text back, with the id and outlet scope of the current run."""
        return {"text": text, "run_id": ctx.run_id, "outlet_scope": list(ctx.outlet_scope)}

    return FunctionTool(echo)
