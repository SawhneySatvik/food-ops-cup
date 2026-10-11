"""Skills loaded just in time (ADR-014 §6.5, ledger R45 F3): `PackToolset` binds the tools of the skills a run loaded.

One PackToolset per context (the Manager's, or one branch's). It owns every tool that context declares — the caller's
fixed tools (`base_tools`: submit_answer, report, abstain, …), `load_skill` when the context may load, and each loaded
skill's generated tools — so the F3 cap of 20 counts the whole context. A load that would pass 20 tools, or a third
skill (§6.1 block 3 holds ≤ 2), is refused and leaves the bound tools unchanged.

`propose` is the typed binding flag. Whether a run may propose (only on `draft_request`, only the Manager) is T-082b's
rule; this module only enforces its other half: with `propose`, exactly one skill may be loaded.

ADK 2.11 caches a toolset's tools per invocation (`BaseToolset._use_invocation_cache`, FACT, tools/base_toolset.py),
which would hide a mid-run `load_skill` from the next model step; ADK's own SkillToolset turns the cache off, and so
does this one.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal

from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import BaseToolset
from google.adk.tools.tool_context import ToolContext
from google.genai import types

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.runtime.state import PACKS, RunState
from munim_intel.skills import SkillSpec, load_skill
from munim_intel.tools.handles import HandleTable

#: Ledger R45 F3.
TOOL_CAP = 20
#: ADR-014 §6.1 block 3: skill instructions (≤ 2).
SKILL_CAP = 2

PayrollScope = Literal["drafts", "roster_only"]
LoadRefusal = Literal["unknown_skill", "skill_cap", "tool_cap", "one_skill_for_drafts"]

_MESSAGES: dict[LoadRefusal, str] = {
    "unknown_skill": "That is not a specialist's skill.",
    "skill_cap": "Two skills are already loaded; answer with them or abstain.",
    "tool_cap": "Loading that skill would pass the tool limit; answer with the loaded skills or abstain.",
    "one_skill_for_drafts": "A proposal run uses exactly one skill; it is already loaded.",
}


class SkillLoadRefused(Exception):
    def __init__(self, reason: LoadRefusal) -> None:
        super().__init__(f"skill load refused: {reason}")
        self.reason: LoadRefusal = reason


class PackToolset(BaseToolset):
    def __init__(
        self,
        ctx: RunContext,
        client: InternalClient,
        handles: HandleTable,
        state: RunState,
        *,
        propose: bool,
        payroll_scope: PayrollScope | None,
        base_tools: Sequence[BaseTool] = (),
        loadable: bool = True,
    ) -> None:
        super().__init__()
        self._use_invocation_cache = False
        self._ctx, self._client, self._handles, self._state = ctx, client, handles, state
        self.propose = propose
        self._payroll_scope = payroll_scope
        self._fixed: list[BaseTool] = [*base_tools, *([LoadSkillTool(self)] if loadable else [])]
        self.skills: list[SkillSpec] = []
        self._bound: list[BaseTool] = []

    @property
    def tools(self) -> list[BaseTool]:
        """What the next model call declares, in a stable order (fixed tools, then skills in load order)."""
        return [*self._fixed, *self._bound]

    async def get_tools(self, readonly_context: ReadonlyContext | None = None) -> list[BaseTool]:
        return self.tools

    def load(self, pack: str) -> SkillSpec:
        """Bind `pack`'s tools; SkillLoadRefused leaves everything as it was. Loading a loaded skill is a no-op."""
        if pack not in PACKS:
            raise SkillLoadRefused("unknown_skill")
        loaded = next((s for s in self.skills if s.pack == pack), None)
        if loaded is not None:
            return loaded
        if self.propose and self.skills:
            raise SkillLoadRefused("one_skill_for_drafts")
        if len(self.skills) >= SKILL_CAP:
            raise SkillLoadRefused("skill_cap")
        spec = load_skill(pack)
        # The one skill that narrows by a run-frame fact (packs/people.md §6): without `drafts`, no payroll proposal.
        frame: dict[str, Any] = {"payroll_scope": self._payroll_scope} if pack == "people" else {}
        names = {t.name for t in self.tools}
        # Two skills may share a tool (market and compliance both propose goals.task.create): bind it once.
        new = [t for t in spec.toolset(self._ctx, self._client, self._handles, propose=self.propose, **frame) if t.name not in names]
        if len(self.tools) + len(new) > TOOL_CAP:
            raise SkillLoadRefused("tool_cap")
        self.skills.append(spec)
        self._bound += new
        for t in new:
            self._state.tool_pack[t.name] = pack
        return spec


class LoadSkillTool(BaseTool):
    """The Manager's `load_skill(pack)`: binds a specialist's tools from the next model step on."""

    def __init__(self, toolset: PackToolset) -> None:
        description = "Load a specialist's skill: its instructions and read tools join from your next step."
        super().__init__(name="load_skill", description=description)
        self._toolset = toolset

    def _get_declaration(self) -> types.FunctionDeclaration:
        schema = {
            "type": "object",
            "properties": {"pack": {"type": "string", "enum": list(PACKS), "description": "The specialist whose skill to load."}},
            "required": ["pack"],
            "additionalProperties": False,
        }
        return types.FunctionDeclaration(name=self.name, description=self.description, parameters_json_schema=schema)

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        pack = args.get("pack")
        try:
            spec = self._toolset.load(pack if isinstance(pack, str) else "")
        except SkillLoadRefused as e:
            return {"error": _MESSAGES[e.reason], "reason": e.reason}
        return {"loaded": spec.pack, "tools": [t.name for t in self._toolset.tools]}
