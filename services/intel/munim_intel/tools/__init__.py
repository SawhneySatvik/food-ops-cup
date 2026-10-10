"""Model tools (04-agent-framework §3). A tool is built per run by a registered factory that closes over the
RunContext (and the run's internal client), so tenant and outlet scope reach a tool only from the verified token.
No tool schema may name a tenant: tests/test_tools.py reflects over every registered factory and fails on one.
"""

from __future__ import annotations

from collections.abc import Callable

from google.adk.tools.base_tool import BaseTool

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient

ToolFactory = Callable[[RunContext, InternalClient], BaseTool]

#: name -> factory. Filled by importing the tool modules below.
TOOLS: dict[str, ToolFactory] = {}


def register(name: str) -> Callable[[ToolFactory], ToolFactory]:
    def add(factory: ToolFactory) -> ToolFactory:
        if name in TOOLS:
            raise ValueError(f"tool {name!r} registered twice")
        TOOLS[name] = factory
        return factory

    return add


def build_tools(names: list[str], ctx: RunContext, client: InternalClient) -> list[BaseTool]:
    return [TOOLS[n](ctx, client) for n in names]


from munim_intel.tools import echo as echo  # noqa: E402  (registers; must follow `register`)
