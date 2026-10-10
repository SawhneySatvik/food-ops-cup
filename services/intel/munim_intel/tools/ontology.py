"""The generated ontology (T-080, ADR-014 §2): packages/contracts/generated/ontology.json, written by `make ontology`.

intel reads the model-facing tool schemas and leaf maps from it; it never re-derives them (one transform, in the
contracts package). The file is the repo's, not intel's: the freshness gate lives with the generator.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

ONTOLOGY_FILE = Path(__file__).resolve().parents[4] / "packages" / "contracts" / "generated" / "ontology.json"

Ontology = dict[str, Any]


@lru_cache(maxsize=1)
def load_ontology() -> Ontology:
    doc: Ontology = json.loads(ONTOLOGY_FILE.read_text(encoding="utf-8"))
    return doc
