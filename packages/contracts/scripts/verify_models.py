"""Gen-time check: every contract class in models.py is the class generated for THAT contract.

datamodel-codegen names inline objects after their field, so an inline `error` object can take the bare
name of a component (`Error`) and push the component to `Error1`. For each contract whose JSON Schema is an
object, the class's field aliases must equal the schema's property names.
stdin: {"<ClassName>": [<property names>] | null, ...}; exit 1 with a list of mismatches.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "intel"))

from munim_intel.contracts_gen import models  # noqa: E402

bad = []
for cls_name, props in json.load(sys.stdin).items():
    cls = getattr(models, cls_name, None)
    if cls is None:
        bad.append(f"{cls_name}: missing")
        continue
    if props is None:
        continue
    fields = sorted((f.alias or n) for n, f in getattr(cls, "model_fields", {}).items())
    if fields != sorted(props):
        bad.append(f"{cls_name}: fields {fields} != schema properties {sorted(props)}")
if bad:
    print("\n".join(bad))
    sys.exit(1)
print(f"verify_models: ok — every contract class matches its schema")
