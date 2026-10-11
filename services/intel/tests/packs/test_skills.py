"""W3.2: the eight specialist skills share ONE shape (ADR-014 §6.5 SkillSpec), read by `load_skill(pack)`.

Expected values are independent of the skill modules: the specialist ids, templates and draftables from the contracts
registry (packages/contracts/src/intel/specialists.ts, read through node), number words from the contracts grammar
(packages/contracts/src/shared/grammar/number-words.json), reason codes from the contracts list, the ≤ 20-tool cap (F3)
and ≤ 1.5k tokens of instructions (ADR-014 §6.1 block 3; about four characters a token).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from functools import cache
from typing import Any, get_args

import pytest

from conftest import REPO
from munim_intel.contracts_gen.models import ReasonCode
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.skills import SkillSpec, load_skill
from munim_intel.tools.handles import HandleTable

CTX = RunContext(
    "01920000-0000-7000-8000-00000000082a", "01920000-0000-7000-8000-00000000082b", ("*",), "ask", "manager", 2_000_000_000, "h.p.s"
)
TOOL_CAP, CHAR_CAP = 20, 6_000


@cache
def registry() -> dict[str, dict[str, Any]]:
    node = shutil.which("node")
    assert node, "node is required: the registry is the contracts package's TypeScript"
    script = "import { SPECIALIST_REGISTRY as r } from './packages/contracts/src/intel/specialists.ts'; console.log(JSON.stringify(r))"
    out = subprocess.run([node, "--input-type=module", "-e", script], cwd=REPO, capture_output=True, text=True, check=True, timeout=60)
    return {s["id"]: s for s in json.loads(out.stdout)["specialists"] if s["kind"] == "specialist"}


def tool_name(command_type: str) -> str:
    """The generated propose tool's name for a command type (tests/tools/test_generated.py names them the same way)."""
    return "propose_" + re.sub(r"\.v[1-9][0-9]*$", "", command_type).replace(".", "_")


def number_words() -> list[str]:
    data = json.loads((REPO / "packages/contracts/src/shared/grammar/number-words.json").read_text("utf8"))
    words: list[str] = [*data["english_cardinals"], *data["english_magnitude_plurals"]]
    return words


def test_the_registry_names_eight_specialists_and_each_has_a_skill() -> None:
    assert len(registry()) == 8
    assert all(isinstance(load_skill(p), SkillSpec) for p in registry())
    with pytest.raises(KeyError):
        load_skill("manager")  # not a specialist: no skill (F8)


@pytest.mark.parametrize("pack", ["catalogue", "kitchen", "inventory_purchasing", "finance", "people", "customers", "compliance", "market"])
def test_each_skill_binds_only_its_registry_tools_within_the_cap_and_cites_without_numbers(pack: str) -> None:
    s, entry = load_skill(pack), registry()[pack]
    client = InternalClient(CTX, base_url="http://core.invalid", service_secret="never-called")
    reads = s.toolset(CTX, client, HandleTable(), propose=False)
    frame = {"payroll_scope": "drafts"} if pack == "people" else {}  # the one skill that narrows by a run-frame fact
    drafting = s.toolset(CTX, client, HandleTable(), propose=True, **frame)
    prose = s.instructions_md
    typed = [w for w in number_words() if re.search(rf"\b{re.escape(w)}\b", prose, flags=re.I)]
    print(f"{pack}: {len(prose)} chars, {len(reads)} reads, {len(drafting)} with proposals, number words {typed}")
    proposals = sorted(t.name for t in drafting if t.name.startswith("propose_"))
    assert s.pack == pack
    # A skill may propose fewer than its registry draftables (customers keeps the campaign out, R-B S1-D), never others.
    assert set(s.read_templates) == set(entry["templates"]) and set(s.draftables) <= set(entry["draftables"])
    assert len(drafting) <= TOOL_CAP and not any(t.name.startswith("propose_") for t in reads)
    assert proposals == sorted(tool_name(d) for d in s.draftables), "the bound proposal tools are exactly the skill's draftables"
    assert len(drafting) - len(reads) == len(s.draftables) and {t.name for t in reads} <= {t.name for t in drafting}
    assert 0 < len(prose) <= CHAR_CAP and re.findall(r"\d", prose) == [] and typed == []
    assert s.refusal_codes and set(s.refusal_codes) <= set(get_args(ReasonCode.model_fields["root"].annotation))
