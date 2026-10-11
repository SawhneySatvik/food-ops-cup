"""Grammar parity (W3 close, R-E 1-A/1-B/2-B): intel's `check_grammar` (munim_intel/tools/grammar.py) gives core's verdict —
rule and match included — on every probe. The judge is core-domain's own `checkGrammar` under node
(tests/tools/grammar_check.mts); the probes are hand-written. Fails — never skips — without node.

R-E's four probes are the reviewer's own strings (its transcript: core's verdicts magnitude_suffix, number_word,
number_word, malformed_ref), first in the table; the rest are hand-written edges of each rule. The typed-bracket and
row/column checks are not grammar rules (core passes a lone bracket): tests/manager (submit_answer) and
tests/context (expand) gate them.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

import pytest

from conftest import INTEL
from munim_intel.tools.grammar import check_grammar, ref_ids, typed_bracket

S = "01920000-0000-7000-8000-000000000500"
SNAP = f"⟨snap:{S}·0·impact_minor⟩"
DOC = f"⟨cite:doc:{S}·0-12⟩"
ROW = f"⟨cite:row:core.order:{S}⟩"

#: The reviewer's ref (R-E transcript).
R_E = "⟨snap:0190a4c2-0000-7000-8000-000000000001·0·net_minor⟩"
PROBES = [
    # R-E's four, verbatim
    f"Food cost rose {R_E}Cr overall",
    f"Seven regulars are at risk {R_E}.",
    f"Short by {R_E} lakh rupees",
    f"Sales were ⟨twelve lakh⟩ while {R_E}",
    # R-E's accept, verbatim
    f"Takings are off {R_E}.",
    # more of each rule
    f"Payouts are short by {SNAP}k.",
    f"Labour moved by ⟨snap:{S}·x·labour⟩.",
    # accepts
    f"Regulars have stopped coming back, about {SNAP} of sales at risk. — Customers desk",
    f"Wastage reached {SNAP}kg on the line.",
    f"The supplier wrote {DOC} on the invoice.",
    f'The supplier wrote "{DOC}" on the invoice.',
    f"The supplier wrote ‘{DOC}’ on the invoice.",
    f"It's the owner's call, see {ROW}.",
    f"Costs rose ⟩ sharply {SNAP}.",
    "Plain prose with no number at all.",
    f"{SNAP}{SNAP}",
    f"Spend is {SNAP} against ₹ and # signs.",
    "A someone-or-other line.",
    # refusals, one per rule and its edges
    f"Payouts are late by 12 days {SNAP}.",
    f"Payouts are late by ५ days {SNAP}.",
    f"Half ½ of it {SNAP}.",
    f"Margin fell {SNAP}% this week.",
    f"Margin fell {SNAP} ％ this week.",
    f"Takings are {SNAP}L.",
    f"Takings are {SNAP}L-ish.",
    f"Takings are {SNAP} lakh.",
    f"Twenty-one regulars {SNAP}.",
    f"A one-off spike {SNAP}.",
    f"Thousands of rupees {SNAP}.",
    f"पाँच ग्राहक {SNAP}.",
    f'The supplier wrote "{SNAP}" on the invoice.',
    f'He said "fine" {SNAP}.',
    f"He said 'fine' {SNAP}.",
    f"⟨snap:bogus⟩ fell {SNAP}.",
    f"Fell by ⟨⟩ {SNAP}.",
    f"Sales fell {SNAP}k{SNAP}.",
    f"Sales fell {SNAP}Crate.",
    "Café sales fell.",
    "Café sales fell.",
    f"x_'a' {SNAP}",
]


def core_verdicts(texts: list[str]) -> list[dict[str, Any]]:
    node = shutil.which("node")
    assert node, "node is required: the parity gate runs core-domain's checkGrammar"
    out = subprocess.run(
        [node, str(INTEL / "tests" / "tools" / "grammar_check.mts")],
        input=json.dumps(texts),
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    result: list[dict[str, Any]] = json.loads(out.stdout)
    return result


def intel_verdict(text: str) -> dict[str, Any]:
    v = check_grammar(text)
    return {"ok": True} if v is None else {"ok": False, "rule": v.rule, "match": v.match}


def test_intel_and_core_give_identical_verdicts_on_every_probe() -> None:
    core = core_verdicts(PROBES)
    mine = [intel_verdict(p) for p in PROBES]
    diff = [(p, c, m) for p, c, m in zip(PROBES, core, mine, strict=True) if c != m]
    assert not diff, "\n".join(f"{p!r}: core {c} intel {m}" for p, c, m in diff)
    # The table is not degenerate: both verdicts occur, and every rule core has fires at least once.
    assert sum(c["ok"] for c in core) >= 8 and sum(not c["ok"] for c in core) >= 15
    assert {c["rule"] for c in core if not c["ok"]} == {
        "malformed_ref",
        "numeric_char",
        "number_symbol",
        "magnitude_suffix",
        "number_word",
        "typed_quotation",
    }


@pytest.mark.parametrize(
    ("probe", "rule"),
    [(PROBES[0], "magnitude_suffix"), (PROBES[1], "number_word"), (PROBES[2], "number_word"), (PROBES[3], "malformed_ref")],
)
def test_r_e_probes_are_refused_by_intel_with_cores_rule(probe: str, rule: str) -> None:
    v = check_grammar(probe)
    assert v is not None and v.rule == rule


def test_paired_accept_a_clean_cited_line_passes() -> None:
    assert check_grammar(PROBES[4]) is None and check_grammar(PROBES[7]) is None


def test_a_typed_bracket_is_refused_before_expansion_and_a_handle_is_not() -> None:
    assert typed_bracket(f"Sales fell {SNAP}.") and typed_bracket("Sales fell ⟩ sharply.")
    assert not typed_bracket("Sales fell {S1.r0.net_minor}.")


def test_ref_ids_cover_snapshot_and_cite_refs_and_skip_malformed_ones() -> None:
    assert ref_ids(f"{SNAP} {DOC} {ROW} {SNAP} ⟨snap:bogus⟩") == [f"snap:{S}", f"doc:{S}", f"row:core.order:{S}"]
