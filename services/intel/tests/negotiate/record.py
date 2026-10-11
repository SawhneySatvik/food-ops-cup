"""Author the recorded fixtures the negotiation gates replay (run by hand: `python tests/negotiate/record.py`).

A missing fixture is authored the way a correct model would answer — the extractor's typed fields read off the simulated
supplier's reply, the chooser's in-set moves with digit-free notes — and written to fixtures/recorded/<key>.json. The
gates never author: they replay through RecordedLlm and fail on a missing fixture. The chooser's authored policy is the
rule default except one judgement call (decision round 2: accept a supplier already at the walk-away price, rather than
counter), so the recorded run shows the model choosing within the set, not echoing the default.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import kit  # noqa: E402
from kit import FIXTURES, CountingLlm, response_json  # noqa: E402

E2E_FIXTURES = FIXTURES.parent / "e2e"
from munim_intel.llm.recorded import request_key  # noqa: E402

NOTES = {
    "counter": "Thank you for the offer. Another supplier has quoted lower, so we ask you to match it.",
    "accept": "Thank you, this works for us.",
    "walk": "Thank you for your time.",
}


def _text(projection: dict[str, Any]) -> str:
    return "\n".join(p.get("text", "") for c in projection["contents"] for p in c["parts"])


def author_extract(projection: dict[str, Any]) -> dict[str, Any]:
    t = _text(projection)
    reply = t.split("<untrusted>")[1].split("</untrusted>")[0]
    minor = int(re.search(r"minor units per major unit: (\d+)", t).group(1))  # type: ignore[union-attr]
    unit = re.search(r"Unit: (\S+)", t).group(1)  # type: ignore[union-attr]
    major, cents = re.search(r"[A-Z]{3} (\d+)\.(\d+) per", reply).groups()  # type: ignore[union-attr]
    head, _, terms = reply.partition("Payment:")
    qty = re.search(rf"(\d+(?:\.\d+)?) {unit}", head).group(1)  # type: ignore[union-attr]
    moq = re.search(rf"(\d+(?:\.\d+)?) {unit}", terms)
    days = re.search(r"net (\d+) days", terms)
    return response_json(
        {
            "unit_price_minor": int(major) * minor + int(cents),
            "qty_milli": round(float(qty) * 1000),
            "min_order_qty_milli": round(float(moq.group(1)) * 1000) if moq else 0,
            "payment_days": int(days.group(1)) if days else 0,
        }
    )


def author_choice(projection: dict[str, Any]) -> dict[str, Any]:
    t = _text(projection)
    round_ = int(re.search(r"Decision round (\d+) of", t).group(1))  # type: ignore[union-attr]
    out: dict[str, Any] = {}
    for letter, latest, walk, allowed in re.findall(r"Supplier ([A-Z]): latest price (\d+); walk-away price (\d+); allowed moves: (.*)", t):
        moves = [m.split(" ")[0] for m in allowed.split(", ")]
        move = "counter" if "counter" in moves else "accept" if "accept" in moves else "walk"
        if round_ == 2 and "accept" in moves and latest == walk:
            move = "accept"
        out[letter] = {"move": move, "note": NOTES[move]}
    return response_json(out)


def author_manager(projection: dict[str, Any]) -> dict[str, Any]:
    if any("response" in p for c in projection["contents"] for p in c["parts"]):
        return response_json({"answer": "cannot verify"})
    r = LlmResponse.model_validate(
        {"content": {"role": "model", "parts": [{"function_call": {"name": "propose_purchasing_po_create_v1", "args": {}}}]}}
    )
    return r.model_dump(mode="json", exclude_none=True)


AUTHORS = {"recorded/extract": author_extract, "recorded/reason": author_choice, "recorded/manager": author_manager}


class AuthorLlm(CountingLlm):
    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        key, canonical, _ = request_key(llm_request)
        if not (self.fixtures_dir / f"{key}.json").is_file():
            projection = json.loads(canonical)
            body = json.dumps({"request": projection, "responses": [AUTHORS[self.model](projection)]}, ensure_ascii=False, indent=1)
            # A planted copy's new fixture also belongs to the committed set; the e2e's fixtures are its own.
            for d in {self.fixtures_dir} if self.fixtures_dir == E2E_FIXTURES else {self.fixtures_dir, FIXTURES}:
                (d / f"{key}.json").write_text(body + "\n", "utf8")
            print(f"authored {self.model} {key}")
        async for r in super().generate_content_async(llm_request, stream):
            yield r


def e2e() -> None:
    """`python tests/negotiate/record.py e2e`: the real-core negotiation (test_negotiate_e2e) with the authoring extractor."""
    import asyncio

    import test_negotiate_e2e as te

    E2E_FIXTURES.mkdir(parents=True, exist_ok=True)
    s = te.Stack(7, [te.WORLD])
    try:
        out, _, _ = asyncio.run(te.scenario(s, te.seed(s), AuthorLlm(model="recorded/extract", fixtures_dir=E2E_FIXTURES)))
        print(f"e2e: draft {out.draft.status if out.draft else None}, dropped {[leg.dropped for leg in out.legs]}")
    finally:
        s.stop()


def main() -> None:
    if sys.argv[1:] == ["e2e"]:
        e2e()
        return
    import test_negotiate_chooser as tc
    import test_negotiate_rules as tr

    kit.LLM = AuthorLlm
    FIXTURES.mkdir(parents=True, exist_ok=True)
    names = [(m, n) for m in (tr, tc) for n in sorted(dir(m)) if n.startswith("test_gate")]
    tests = [getattr(m, n) for m, n in names if "tmp_path" in getattr(m, n).__code__.co_varnames]
    # Two passes: a gate that plants a copy of the fixtures may run before the gate that authors what it copies, so the
    # first pass only authors (its failures are expected) and the second must be green.
    for strict in (False, True):
        for t in tests:
            with tempfile.TemporaryDirectory() as d:
                try:
                    t(Path(d))
                except AssertionError:
                    if strict:
                        raise
                    print(f"authoring pass: {t.__name__} not green yet")
                    continue
                print(f"ok {t.__name__}")


if __name__ == "__main__":
    main()
