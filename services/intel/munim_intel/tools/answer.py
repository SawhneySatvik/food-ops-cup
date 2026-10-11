"""`submit_answer` (ADR-014 §5.1, §5.3, §5.7; R25): the one way a Manager ask ends. It folds `abstain` in (T-082a found
the F3 cap tight: inventory_purchasing with its propose tools is 19, so a draft run has room for one base tool).

  segments   short prose; every number is a cell handle in braces ({S1.r0.net_minor}). Each segment is rendered
             through the run's HandleTable, fail closed (context/expand.py): a ref delimiter the model typed itself, an
             unresolved handle, a segment citing nothing, or anything core's number grammar refuses (tools/grammar.py:
             digits, number words, a magnitude suffix after a ref, a quotation) is refused with the segment index and the
             rule — one retry, then the answer is an abstention with that rule's code (§5.3).
  abstain    one reason code instead: the loaded skills' refusal codes plus missing_ref and insufficient_history.

`refs` are built here from the expanded canonical refs, never from the model's input. The first submission wins and
ends the run (ADK `skip_summarization`: no extra model step to restate it). Nothing is posted here: the ask posts the
envelope once, after the run, under core's answer id (manager/ask.py), and core's validator decides again.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import Any

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types

from munim_intel.context.expand import CANNOT_VERIFY, expand
from munim_intel.contracts_gen.models import AnswerEnvelope
from munim_intel.tools.args import problems
from munim_intel.tools.grammar import check_grammar, reason_code, typed_bracket
from munim_intel.tools.handles import DOT, SNAP_CLOSE, SNAP_OPEN, HandleTable

#: ADR-014 §5.1: every skill may abstain with these, beside its own refusal codes.
ALWAYS = ("missing_ref", "insufficient_history")
#: ADR-014 §6.3's report bound, used for the answer too: ≤ 6 segments.
MAX_SEGMENTS = 6
#: contracts `Segment.text` max.
TEXT_CHARS = 2000
_CANONICAL = re.compile(rf"{SNAP_OPEN}[^{SNAP_CLOSE}]*{SNAP_CLOSE}")


def ref_id(token: str) -> str:
    """The bare RefId core expects in `refs[]`: ⟨snap:<id>·r·c⟩ → snap:<id>; ⟨cite:<kind>:<id>[·span]⟩ → <kind>:<id>."""
    inner = token[1:-1]
    return inner.split(DOT)[0] if inner.startswith("snap:") else inner.removeprefix("cite:").split(DOT)[0]


class SubmitAnswerTool(BaseTool):
    def __init__(self, answer_id: str, handles: HandleTable, codes: Callable[[], Sequence[str]]) -> None:
        super().__init__(
            name="submit_answer",
            description=(
                "Finish the answer: short segments, each citing at least one cell handle in braces, or abstain with one "
                "reason code and no segments. Call it once."
            ),
        )
        self._answer_id = answer_id
        self._handles = handles
        self._codes = codes
        self._refused = 0
        #: The answer, once submitted (first call wins).
        self.envelope: AnswerEnvelope | None = None

    def schema(self) -> dict[str, Any]:
        codes = list(dict.fromkeys([*self._codes(), *ALWAYS]))
        return {
            "type": "object",
            "properties": {
                "segments": {
                    "type": "array",
                    "description": "Short sentences; each number is a cell handle in braces, e.g. {S1.r0.<column>}. Empty to abstain.",
                    "items": {
                        "type": "object",
                        "properties": {"text": {"type": "string", "description": "One sentence citing cell handles in braces."}},
                        "required": ["text"],
                        "additionalProperties": False,
                    },
                    "maxItems": MAX_SEGMENTS,
                },
                "abstain": {
                    "type": ["string", "null"],
                    "enum": [*codes, None],
                    "description": "A reason code when the evidence cannot answer the question; null when answering.",
                },
            },
            "required": ["segments", "abstain"],
            "additionalProperties": False,
        }

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(name=self.name, description=self.description, parameters_json_schema=self.schema())

    def validate_args(self, args: dict[str, Any]) -> str | None:
        """The plugin's §5.3 argument check (it calls this before the tool runs)."""
        found = problems(self.schema(), args)
        return f"invalid arguments for submit_answer: {'; '.join(found)}."[:300] if found else None

    def _segment(self, i: int, text: str) -> tuple[dict[str, Any] | None, str | None, str | None]:
        """(segment, problem for the model, reason code if it stands). Problems name the rule, never the text."""
        if typed_bracket(text):
            return None, f"segment {i}: never type a ref; cite only handles in braces, e.g. {{S1.r0.<column>}}.", "unresolved_ref"
        out = expand(text, self._handles)
        if out == CANNOT_VERIFY:
            return None, f"segment {i}: a handle did not resolve; cite only handles returned in this run.", "unresolved_ref"
        refs = list(dict.fromkeys(ref_id(t) for t in _CANONICAL.findall(out)))
        if not refs:
            return None, f"segment {i}: it cites no cell; every segment cites a handle in braces.", "missing_ref"
        v = check_grammar(out)
        if v is not None:
            return None, f"segment {i}: {v.rule}; write every number as a cell handle in braces, never typed.", reason_code(v)
        if len(out) > TEXT_CHARS:
            return None, f"segment {i}: too long; split it.", "missing_ref"
        return {"text": out, "refs": refs}, None, None

    def _done(self, tool_context: ToolContext, envelope: dict[str, Any]) -> None:
        self.envelope = AnswerEnvelope.model_validate({"answer_id": self._answer_id, **envelope})
        tool_context.actions.skip_summarization = True

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        if self.envelope is not None:
            return {"error": "An answer was already submitted."}
        code = args["abstain"]
        if code is not None:
            self._done(tool_context, {"segments": [], "abstained": True, "reason_code": code})
            return {"status": "abstained", "reason_code": code}
        texts = [s["text"] for s in args["segments"]]
        segments: list[dict[str, Any]] = []
        problem, reason = (None, None) if texts else ("Give at least one segment, or abstain with a reason code.", "missing_ref")
        for i, text in enumerate(texts):
            seg, problem, reason = self._segment(i, text)
            if seg is None:
                break
            segments.append(seg)
        if problem is None:
            self._done(tool_context, {"segments": segments, "abstained": False, "reason_code": None})
            return {"status": "submitted"}
        self._refused += 1
        if self._refused > 1:
            self._done(tool_context, {"segments": [], "abstained": True, "reason_code": reason})
            return {"status": "abstained", "reason_code": reason}
        return {"error": problem}
