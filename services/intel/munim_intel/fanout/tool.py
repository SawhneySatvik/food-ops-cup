"""`fan_out(specialists, question)` (ledger R45 F5, F8; ADR-014 §3.3, §3.4, §5.1, §6.3, §6.4 rule 3): the Manager's tool
on the unaddressed `investigate` path. It runs one branch per specialist (≤ 4), concurrently, each in its own ADK Runner
with its own InMemorySessionService (`run_agent`) — never `ParallelAgent`, which shares session state and shows each
branch the events that led to the fan-out (§6.3, FACT).

A branch is that specialist acting read-only:
  context   blocks 1–3 for its one skill, its tools, block 5 (the run frame) and the brief — the Manager's question in
            its own words. No Manager turn, thread, investigation or finding enters a branch (`Assembler(kind="branch")`).
  tools     its skill's read tools and `report`. No `propose_*`, `request_quotes`, `load_skill` or `fan_out`.
  output    `report`: submit_answer's fail-closed checks (every handle resolves, every segment cites a cell, no typed
            number; one retry, then an abstention with the rule's code), returned in handle form so the Manager cites
            the same cells through the run's one HandleTable without retyping anything.
A specialist off for every outlet kind in scope (kitchen on shops) answers `not_applicable` without a model call.

Deviation from §6.3's "shares the per-run RunState" (reported): a branch has its own RunState over the run's shared
HandleTable and TraceBuffer. Its own Budget carries §3.4's per-branch caps, which one shared Budget cannot enforce; its
own taint flag reaches the Manager's RunState through `BranchReport.tainted`, which the plugin ORs into the run
(`_carries_taint`) when fan_out returns, before the Manager's next model step (§6.4 rule 3). That is the one path, so
removing it shows (gate 5). A branch starts tainted when the run already is.

Traces carry `branch:<pack>` (the actor ContextVar run_agent sets per task), labels and ids only — never the brief or a
segment (§6.4 rule 5).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types

from munim_intel.config import Config
from munim_intel.context.assembler import AGENT_NAME, CORE_RULES, Assembler, skill_block, tokens
from munim_intel.contracts_gen.models import InternalRunFrameResponse
from munim_intel.manager.paths import not_applicable
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import PACKS, Budget, RunState
from munim_intel.skills import SkillSpec
from munim_intel.skills.loader import PackToolset
from munim_intel.tools.answer import ALWAYS, SubmitAnswerTool
from munim_intel.tools.args import problems
from munim_intel.tools.handles import HandleTable

log = logging.getLogger("munim_intel.fanout")

#: ADR-014 §3.4 "ask, fan-out": ≤ 4 branches, depth 1.
MAX_BRANCHES = 4
#: §6.3: a brief of at most 1k tokens.
BRIEF_TOKENS = 1_000
#: The abstention of a branch that ended without a report (§5.3: "cannot verify").
NO_REPORT = "missing_ref"


def orchestrator_budget() -> Budget:
    """§3.4 "ask, fan-out: orchestrator" (provisional; re-based by T-059)."""
    return Budget(max_model_calls=6, max_input_tokens=100_000, max_tool_calls=6)


def branch_budget() -> Budget:
    """§3.4 "ask, fan-out: each branch". With the orchestrator's: ≤ 100k + 4 × 60k = 340k, the run-total row."""
    return Budget(max_model_calls=6, max_input_tokens=60_000, max_tool_calls=8)


def output_contract(skills: list[SkillSpec]) -> str:
    """Block 2 for a branch: it ends in `report`, with abstain folded in (as the Manager's submit_answer)."""
    codes = list(dict.fromkeys([c for s in skills for c in s.refusal_codes] + list(ALWAYS)))
    return (
        "Output contract:\n"
        "- You answer the Manager's brief as one specialist, read-only. Finish by calling report once with short segments; "
        "every number in a segment is a cell handle in braces.\n"
        f"- To abstain, call report with no segments and abstain set to one reason code: {', '.join(codes)}."
    )


class BranchAssembler(Assembler):
    def system(self) -> str:
        return "\n\n".join([CORE_RULES, output_contract(self.toolset.skills), skill_block(self.toolset.skills)])


class ReportTool(SubmitAnswerTool):
    """`report`: how a branch ends. submit_answer's checks; the accepted segments stay in handle form."""

    def __init__(self, handles: HandleTable, codes: Callable[[], Sequence[str]]) -> None:
        super().__init__("", handles, codes)
        self.name = "report"
        self.description = (
            "Finish your part of the Manager's brief: short segments, each citing at least one cell handle in braces, or "
            "abstain with one reason code and no segments. Call it once."
        )
        #: {segments: [{text, refs}], abstained, reason_code}, once reported (first call wins).
        self.report: dict[str, Any] | None = None

    def _segment(self, i: int, text: str) -> tuple[dict[str, Any] | None, str | None, str | None]:
        seg, problem, reason = super()._segment(i, text)
        return (None if seg is None else {"text": text, "refs": seg["refs"]}), problem, reason

    def _done(self, tool_context: ToolContext, envelope: dict[str, Any]) -> None:
        self.report = envelope
        tool_context.actions.skip_summarization = True

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        if self.report is not None:
            return {"error": "A report was already made."}
        return await super().run_async(args=args, tool_context=tool_context)


@dataclass(frozen=True)
class Branches:
    """What fan_out needs to run branches: their model (the `reason` role, as the Manager's) and the config that
    redacts a failed run's text."""

    model: BaseLlm
    cfg: Config


@dataclass
class Branch:
    """One branch of this run, kept for the gates: its own RunState (budget spent, taint) and the tools it declared."""

    pack: str
    state: RunState
    tools: tuple[str, ...] = ()


def branch_report(pack: str, report: dict[str, Any], tainted: bool) -> dict[str, Any]:
    """BranchReport{pack, segments (handle form), abstain, tainted} — what the Manager's model sees."""
    return {
        "pack": pack,
        "segments": [s["text"] for s in report["segments"]],
        "abstain": report["reason_code"] if report["abstained"] else None,
        "tainted": tainted,
    }


class FanOutTool(BaseTool):
    def __init__(
        self,
        ctx: RunContext,
        client: InternalClient,
        handles: HandleTable,
        state: RunState,
        frame: InternalRunFrameResponse,
        branches: Branches,
    ) -> None:
        super().__init__(
            name="fan_out",
            description=(
                "Ask up to four specialists the same brief at once; each reads its own data, read-only, and returns a "
                "report of segments citing cell handles in braces, or an abstention. Merge the reports into submit_answer, "
                "citing the same handles. Call it once."
            ),
        )
        self._ctx, self._client, self._handles, self._state, self._frame = ctx, client, handles, state, frame
        self._model, self._cfg = branches.model, branches.cfg
        self._kinds = frozenset(o.kind for o in frame.outlets)
        #: This run's branches, in the order asked.
        self.branches: list[Branch] = []

    def schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "specialists": {
                    "type": "array",
                    "description": "The specialists to ask, each once, at most four.",
                    "items": {"type": "string", "enum": list(PACKS)},
                    "minItems": 1,
                    "maxItems": MAX_BRANCHES,
                },
                "question": {
                    "type": "string",
                    "description": "The brief every specialist answers: the question in your words and the period it covers.",
                },
            },
            "required": ["specialists", "question"],
            "additionalProperties": False,
        }

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(name=self.name, description=self.description, parameters_json_schema=self.schema())

    def validate_args(self, args: dict[str, Any]) -> str | None:
        """The plugin's §5.3 argument check (it calls this before the tool runs)."""
        found = problems(self.schema(), args)
        return f"invalid arguments for fan_out: {'; '.join(found)}."[:300] if found else None

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        if self.branches:
            return {"error": "fan_out already ran in this run; merge its reports into submit_answer."}
        question: str = args["question"]
        if tokens(question) > BRIEF_TOKENS:
            return {"error": "The brief is too long; ask in a sentence or two."}
        packs = list(dict.fromkeys(args["specialists"]))
        tasks = [asyncio.ensure_future(self._branch(p, question)) for p in packs]
        try:
            return {"reports": list(await asyncio.gather(*tasks))}
        except BaseException:
            # A branch that raised (rather than failing into its report) ends the fan-out: its siblings are cancelled, not
            # left spending model calls behind a run that has already failed (R-E 3). Their run_agent `finally` still
            # flushes what they traced and spent; the original error is what leaves.
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

    async def _branch(self, pack: str, question: str) -> dict[str, Any]:
        actor = f"branch:{pack}"
        # The run's TraceBuffer, HandleTable and spend Meter; the branch's own budget and taint flag.
        run = self._state
        state = RunState(traces=run.traces, budget=branch_budget(), tainted=run.tainted, handles=run.handles, meter=run.meter)
        branch = Branch(pack, state)
        self.branches.append(branch)
        if not_applicable(pack, self._kinds):
            await state.traces.append("abstain", actor, {"reason": "not_applicable"})
            return branch_report(pack, {"segments": [], "abstained": True, "reason_code": "not_applicable"}, state.tainted)
        toolset: PackToolset
        report = ReportTool(self._handles, lambda: [c for s in toolset.skills for c in s.refusal_codes])
        toolset = PackToolset(
            self._ctx,
            self._client,
            self._handles,
            state,
            propose=False,
            payroll_scope=self._frame.payroll_scope,
            base_tools=[report],
            loadable=False,
        )
        toolset.load(pack)
        branch.tools = tuple(t.name for t in toolset.tools)
        assembler = BranchAssembler("branch", state, self._handles, toolset, self._frame, self._ctx.trigger)
        agent = LlmAgent(
            name=AGENT_NAME["branch"],
            model=self._model,
            instruction=assembler.instruction,
            tools=[toolset],
            before_model_callback=assembler.before_model,
        )
        await state.traces.append("skill_load", actor, {"skill": pack, "by": "fan_out"})
        try:
            await run_agent(agent, self._ctx, question, self._cfg, state=state, actor=actor)
        except RunFailed as e:
            # Rule 11: the branch degrades to "cannot verify"; the failure's class name only, never its text.
            log.warning("intel: run %s branch %s failed: %s", self._ctx.run_id, pack, e.kind)
        done = report.report or {"segments": [], "abstained": True, "reason_code": NO_REPORT}
        return branch_report(pack, done, state.tainted)
