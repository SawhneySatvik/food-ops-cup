"""T-044 skill gate: the Menu & Pricing SkillSpec (ADR-014 §5.1; BOARD T-044 "SkillSpec valid and ≤ 20 tools").
Expected lists come from the ontology's own specialist entry (packages/contracts/generated/ontology.json, generated
from the T-087a registry) and the contracts' reason codes — never from the skill module under test."""

from __future__ import annotations

import re
from typing import get_args

from menu_market_harness import CTX

from munim_intel.contracts_gen.models import ReasonCode
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.skills.catalogue import skill
from munim_intel.tools.handles import HandleTable
from munim_intel.tools.ontology import load_ontology

#: ADR-014 §5.1: ≤ 20 tools per context (F3); the skill's instructions ≤ 1.5k characters (BOARD T-044…T-051).
TOOL_CAP, CHAR_CAP = 20, 1_500


def check(module: object, pack: str) -> None:
    text: str = module.INSTRUCTIONS_MD  # type: ignore[attr-defined]
    print(f"{pack}: {len(text)} characters")
    assert 0 < len(text) <= CHAR_CAP
    assert re.findall(r"\d", text) == [], "a digit in the instructions is a number the model could repeat uncited"
    ont = load_ontology()
    entry = next(s for s in ont["specialists"] if s["id"] == pack)
    fns = {f["id"]: f["tool"] for f in ont["functions"]}
    acts = {a["command_type"]: a["tool"] for a in ont["actions"]}
    reads = sorted(fns[t] for t in entry["templates"])
    proposes = sorted(acts[d] for d in entry["draftables"])
    client = InternalClient(CTX, base_url="http://core.invalid", service_secret="never-called")
    asked = sorted(t.name for t in module.toolset(CTX, client, HandleTable(), propose=False))  # type: ignore[attr-defined]
    drafting = sorted(t.name for t in module.toolset(CTX, client, HandleTable(), propose=True))  # type: ignore[attr-defined]
    print(f"{pack} tools:", drafting)
    # The W3.2 graph wiring (orchestrator's hand list): only catalogue and inventory_purchasing bind `graph_*` tools.
    graph = sorted(f"graph_{g}" for g in module.GRAPH_TEMPLATES) if pack in ("catalogue", "inventory_purchasing") else []  # type: ignore[attr-defined]
    assert asked == sorted(reads + graph) and drafting == sorted(reads + proposes + graph)
    assert len(drafting) <= TOOL_CAP
    codes = set(get_args(ReasonCode.model_fields["root"].annotation))
    refusals = module.REFUSAL_CODES  # type: ignore[attr-defined]
    assert refusals and set(refusals) <= codes
    assert all(code in text for code in refusals), "each refusal the skill may give is named in its instructions"


def test_the_catalogue_skill_binds_its_registry_tools_and_names_its_refusals() -> None:
    check(skill, "catalogue")
    # Pack §7: margin without a recipe → recipe_missing; a recipe line without a price → cost_price_missing.
    assert skill.REFUSAL_CODES == ("recipe_missing", "cost_price_missing")
