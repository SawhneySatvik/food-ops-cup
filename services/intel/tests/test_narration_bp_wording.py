"""A `*_bp` slot renders as a percent in the console (packages/ui format.ts), so detector prose must not also say
"basis points" / "bp" — it read "up 14% basis points" (W4-spine review)."""

from __future__ import annotations

import importlib
import pkgutil
import re

import munim_intel.watch.detectors as detectors
from munim_intel.detect import REGISTRY

BP_SLOT = re.compile(r"\{\w*_bp\}")
BP_WORDING = re.compile(r"basis points?|\bbps?\b", re.IGNORECASE)


def test_no_narration_names_a_bp_ref_in_basis_points() -> None:
    for m in pkgutil.walk_packages(detectors.__path__, detectors.__name__ + "."):
        importlib.import_module(m.name)
    specs = [s for ss in REGISTRY.values() for s in ss]
    with_bp = [s for s in specs if BP_SLOT.search(s.narration)]
    assert len(with_bp) >= 5  # the five detectors fixed in b-101 all carry a bp slot
    bad = [s.id for s in with_bp if BP_WORDING.search(s.narration)]
    assert bad == []
