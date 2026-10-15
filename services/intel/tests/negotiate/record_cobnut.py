"""Author the recorded fixtures a Cobnut negotiation replays (T-114; run by hand: `python tests/negotiate/record_cobnut.py`).

Production runs `MUNIM_MODEL_MODE=recorded` until the founder sets AI prices (F-3), so the models of a negotiation the
Cobnut demo starts read `services/intel/fixtures/recorded/` (llm/recorded.py's key scheme: the sha256 of the request's
projection). A negotiation's model requests hold no date, no id and no outlet — only what the simulated suppliers reply
(item, quantity, price, terms) and the prices the chooser weighs — so they are fixed by:

  the ingredient   "Roasted hazelnuts (synthetic)", kg (tools/worldgen/src/worlds/cobnut.ts)
  the anchor       148000 paise per kg, Lalbagh Nut & Spice's listed price (cobnut.ts), the lowest last price held
  the quantity     1 kg: the shortfall the T-114 end-to-end gate sets up through the owner's own stock count
  the suppliers    suppliers-sim's three personalities, in that order (letters A, B, C), and the owner's default bounds
  the clause       the discounter's minimum-order sentence: the sim picks one of ten by the run's context id, so all ten

A missing fixture is authored the way record.py authors the S1 ones (`author_extract`: the fields read off the reply;
`author_choice`: the rule default, except accept at decision 2 a supplier already at the walk-away) and written here
only; an existing one is left as it is. Any other quantity or price misses (the extractor drops that supplier,
`model_error:RecordedFixtureMissing`) — the founder item in the T-114 report.
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path

import httpx
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from record import AUTHORS  # noqa: E402

from kit import DEFAULT_POLICY, INGREDIENT, PUBLIC, SUPPLIER_IDS, WORLD, FakeCore, build_app, cfg, load_data, suppliers  # noqa: E402
from munim_intel.llm.recorded import FIXTURES_DIR, RecordedLlm, request_key  # noqa: E402
from munim_intel.negotiate.chooser import LlmChooser  # noqa: E402
from munim_intel.negotiate.port import A2aSuppliers  # noqa: E402
from munim_intel.negotiate.run import negotiate, negotiation_budget, rfq_from  # noqa: E402
from munim_intel.runtime.context import RunContext  # noqa: E402
from munim_intel.runtime.state import RunState  # noqa: E402
from munim_intel.tools.generated import uuid7  # noqa: E402
from munim_intel.trace.buffer import TraceBuffer  # noqa: E402

ITEM, UNIT, QTY_MILLI, REFERENCE_MINOR = "Roasted hazelnuts (synthetic)", "kg", 1_000, 148_000
CLAUSES = 10


class Author(RecordedLlm):
    """Replays an existing fixture; authors a missing one into the production fixtures directory only."""

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        key, canonical, _ = request_key(llm_request)
        path = self.fixtures_dir / f"{key}.json"
        if not path.is_file():
            projection = json.loads(canonical)
            body = {"request": projection, "responses": [AUTHORS[self.model](projection)]}
            path.write_text(json.dumps(body, ensure_ascii=False, indent=1) + "\n", "utf8")
            print(f"authored {self.model} {key}")
        async for r in super().generate_content_async(llm_request, stream):
            yield r


async def one(clause: int, tmp: Path) -> str:
    run_id = uuid7(int(datetime.now(UTC).timestamp() * 1000), f"cobnut/{clause}")
    ctx = RunContext(
        run_id,
        "0199a000-0000-7000-8000-000000000001",
        ("0199a000-0000-7000-8000-0000000000a3",),
        "ask",
        "0199a000-0000-7000-8000-0000000000f9",
        2_000_000_000,
        "t",
    )
    core = FakeCore(WORLD["deal_inputs"], run_id=run_id)
    shortfall = core._snapshot(
        "inventory.shortfall",
        {"outlet_id": None, "lead_days": 6},
        [("ingredient_id", "uuid"), ("shortfall_qty_milli", "integer")],
        [{"ingredient_id": INGREDIENT, "shortfall_qty_milli": QTY_MILLI}],
    ).model_dump(mode="json")
    price = core._snapshot(
        "purchasing.price_creep",
        {"as_of": "2026-10-15"},
        [("supplier_id", "uuid"), ("ingredient_id", "uuid"), ("latest_minor", "integer")],
        [{"supplier_id": SUPPLIER_IDS["steady"], "ingredient_id": INGREDIENT, "latest_minor": REFERENCE_MINOR}],
    ).model_dump(mode="json")
    rfq = rfq_from(shortfall, 0, price, 0, "latest_minor", item_name=ITEM, unit=UNIT, currency="INR", minor_unit=2,
                   needed_by="2026-10-21", outlet_ids=ctx.outlet_scope)  # fmt: skip
    state = RunState(traces=TraceBuffer(core.write_traces), budget=negotiation_budget(3, DEFAULT_POLICY))
    chooser = LlmChooser(
        Author(model="recorded/reason"), ctx, cfg(tmp), state, currency="INR", unit=UNIT, calls=DEFAULT_POLICY.decision_rounds
    )
    app = build_app(PUBLIC, data=load_data(), clause=clause)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=PUBLIC) as http:
        out = await negotiate(ctx, rfq, suppliers(), port=A2aSuppliers(http, PUBLIC), core=core, chooser=chooser,
                              extract_llm=Author(model="recorded/extract"), state=state, policy=DEFAULT_POLICY)  # fmt: skip
    dropped = [leg.dropped for leg in out.legs if leg.dropped]
    return f"clause {clause}: quotes {len(core.quotes)}, dropped {dropped}, draft {'yes' if out.draft else 'no'}"


def main() -> None:
    import tempfile

    assert FIXTURES_DIR.is_dir()
    for clause in range(CLAUSES):
        with tempfile.TemporaryDirectory() as d:
            print(asyncio.run(one(clause, Path(d))))


if __name__ == "__main__":
    main()
