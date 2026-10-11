"""Skills (ADR-014 §6.5): one hand-written `skills/<pack>/skill.py` per specialist, all of ONE shape — module constants

    PACK, INSTRUCTIONS_MD, READ_TEMPLATES, DRAFTABLES, REFUSAL_CODES, GRAPH_TEMPLATES, SHARED_TOOLS
    toolset(ctx, client, handles, *, propose, **frame) -> list[BaseTool]   the generated read (+ propose) tools
    refusal(template_id, rows) -> reason_code | None                  optional: a pack §7 refusal as code over cells

`load_skill(pack)` reads one into a SkillSpec. Binding propose tools only on `draft_request`, with one skill loaded, is
the Manager's rule (T-082a's `skills/loader.py` builds on this). Nothing here calls a model or core.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from google.adk.tools.base_tool import BaseTool

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.runtime.state import PACKS
from munim_intel.tools.handles import HandleTable

Refusal = Callable[[str, Sequence[Mapping[str, object]]], str | None]
Toolset = Callable[..., list[BaseTool]]


@dataclass(frozen=True)
class SkillSpec:
    pack: str
    instructions_md: str
    read_templates: tuple[str, ...]
    draftables: tuple[str, ...]
    refusal_codes: tuple[str, ...]
    graph_templates: tuple[str, ...]
    shared_tools: tuple[str, ...]
    #: The pack §7 refusals that are code over typed cells (instructions carry no digits); None — the pack has none.
    refusal: Refusal | None
    _toolset: Toolset

    def toolset(self, ctx: RunContext, client: InternalClient, handles: HandleTable, *, propose: bool, **frame: object) -> list[BaseTool]:
        """`frame`: run-frame facts a skill narrows its tools by (people: `payroll_scope`)."""
        return self._toolset(ctx, client, handles, propose=propose, **frame)


def load_skill(pack: str) -> SkillSpec:
    """The specialist's skill. A pack that is not a specialist is refused (F8), never guessed."""
    if pack not in PACKS:
        raise KeyError(f"no skill for {pack!r}: not a specialist")
    m = importlib.import_module(f"munim_intel.skills.{pack}.skill")
    if m.PACK != pack:
        raise ValueError(f"skills/{pack}/skill.py declares PACK {m.PACK!r}")
    return SkillSpec(
        pack=m.PACK,
        instructions_md=m.INSTRUCTIONS_MD,
        read_templates=tuple(m.READ_TEMPLATES),
        draftables=tuple(m.DRAFTABLES),
        refusal_codes=tuple(m.REFUSAL_CODES),
        graph_templates=tuple(m.GRAPH_TEMPLATES),
        shared_tools=tuple(m.SHARED_TOOLS),
        refusal=getattr(m, "refusal", None),
        _toolset=m.toolset,
    )
