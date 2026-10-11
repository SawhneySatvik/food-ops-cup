"""T-051 skill gate: the Market & Strategy SkillSpec — same checks as the catalogue skill (test_catalogue_skill.check)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "catalogue"))
from test_catalogue_skill import check  # noqa: E402

from munim_intel.skills.market import skill  # noqa: E402


def test_the_market_skill_binds_its_registry_tools_and_names_its_refusals() -> None:
    check(skill, "market")
    # Pack §7: no imported signal → signal_source_missing; viability without closed months or rent/capex → insufficient_history.
    assert skill.REFUSAL_CODES == ("signal_source_missing", "insufficient_history")
