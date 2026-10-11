"""The PO draft body deal review posts parses with core-api's own zod contract (`DraftsRequest`, draftable registry
loaded — tests/tools/zod_check.mts), and the same check refuses it with a bare number where a quote ref belongs.

It is a workflow draft (DECISIONS 11 Oct, "W3.2 ruling — workflow draftables"): deterministic code posts it from a run
already tainted by supplier replies, through the ordinary internal drafts call as `inventory_purchasing`; core re-validates
the body. The end-to-end post here is FakeCore's; against today's core no refusal is expected (step 0 already admits
`purchasing.po.create.v1` for this pack, the drafts route has no taint check, and based_on is non-empty), so nothing is
marked xfail."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from conftest import INTEL
from kit import no_fixture_misses as no_fixture_misses  # autouse: a missing recorded fixture fails the test
from kit import run_s1


def _zod(drafts: list[dict[str, Any]]) -> list[list[str]]:
    node = shutil.which("node")
    assert node, "node is required: this gate parses with core-api's zod contracts"
    out = subprocess.run(
        [node, str(INTEL / "tests" / "tools" / "zod_check.mts")],
        input=json.dumps({"drafts": drafts, "snapshots": []}),
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    result: list[list[str]] = json.loads(out.stdout)["drafts"]
    return result


def test_po_draft_parses_with_core_zod_and_a_bare_number_is_refused(tmp_path: Path) -> None:
    r = asyncio.run(run_s1(tmp_path))
    body = r.outcome.draft_request
    assert body is not None and body["pack"] == "inventory_purchasing" and body["command_type"] == "purchasing.po.create.v1"
    bad = json.loads(json.dumps(body))
    bad["payload"]["lines"][0]["unit_price_minor"] = "792"
    got = _zod([body, bad])
    print(f"zod: PO body issues {got[0]}; bare-number body issues {got[1]}; based_on {len(body['based_on'])} cells")
    assert got[0] == [] and got[1] != []
    assert r.state.tainted is True and len(body["based_on"]) >= 1
