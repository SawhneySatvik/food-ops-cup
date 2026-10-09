"""TS -> Pydantic -> TS round trip helper (T-002 gate).

stdin:  {"<contract name>[#<tag>]": <sample>, ...}
stdout: {"<key>": {"ok": <re-serialised sample>} | {"error": "<message>"}, ...}
Imports the generated models by path (services/intel), never an installed package.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "intel"))

from munim_intel.contracts_gen import CONTRACTS, models  # noqa: E402


def floats(v, path="$"):
    """No contract carries a float (money is integer minor units, decimals are strings). JSON cannot tell
    12000 from 12000.0 once JS parses it, so a float in a dump is reported here instead."""
    if isinstance(v, float):
        return [path]
    if isinstance(v, dict):
        return [p for k, x in v.items() for p in floats(x, f"{path}.{k}")]
    if isinstance(v, list):
        return [p for i, x in enumerate(v) for p in floats(x, f"{path}[{i}]")]
    return []


out = {}
for key, sample in json.load(sys.stdin).items():
    try:
        cls = getattr(models, CONTRACTS[key.split("#", 1)[0]])
        obj = cls.model_validate(sample)
        dumped = obj.model_dump(mode="json", by_alias=True, exclude_unset=True)
        bad = floats(dumped)
        out[key] = {"error": f"float in dump at {bad}"} if bad else {"ok": dumped}
    except Exception as e:  # report every failure; the TS test asserts on the set
        out[key] = {"error": f"{type(e).__name__}: {e}"[:2000]}
json.dump(out, sys.stdout, ensure_ascii=False)
