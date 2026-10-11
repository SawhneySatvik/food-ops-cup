"""The pack lanes' end-to-end harness: T-043's stack (tests/watch/stack.py, used read-only: embedded Postgres + the real
core-api, the four worldgen worlds seeded through the API at the gate profile — 100 days to 2026-10-10) driven through
intel's real `/watch:sweep`. Fails — never skips — without node."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "watch"))

from fastapi.testclient import TestClient  # noqa: E402
from stack import Bridge, Stack  # noqa: E402

from conftest import REPO  # noqa: E402
from munim_intel.app import create_app  # noqa: E402
from munim_intel.config import Config, load_config  # noqa: E402
from munim_intel.runtime.context import RunContext  # noqa: E402
from munim_intel.watch.frame import Frame  # noqa: E402

WORLDS = ["restaurant_group", "cloud_kitchen", "store", "au_outlet"]
DAYS = 100  # tools/worldgen/test/profile.ts: long enough for every long-window plant
FINDINGS = """SELECT f.tenant_id::text, f.id::text, f.pack, f.type, f.severity, f.dedupe_key, f.confidence_bp, f.envelope,
                     f.impact_snapshot_id::text AS impact_snapshot, f.impact_row, f.impact_column,
                     (s.rows -> f.impact_row ->> f.impact_column)::bigint AS impact
                FROM intel.finding f JOIN evidence.snapshot s ON s.tenant_id = f.tenant_id AND s.id = f.impact_snapshot_id
               WHERE f.pack = $1 ORDER BY f.dedupe_key"""


def answer_key(plant: str) -> dict[str, Any]:
    world = {"RG": "restaurant_group", "CK": "cloud_kitchen", "ST": "store", "AU": "au_outlet"}[plant[:2]]
    key = json.loads((REPO / "tools" / "worldgen" / "answer-key" / f"{world}.json").read_text("utf8"))
    entry: dict[str, Any] = next(p for p in key["problems"] if p["id"] == plant)
    return entry


class Harness:
    def __init__(self, stack: Stack, run_dir: Path) -> None:
        self.stack = stack
        (run_dir / "keys").mkdir(parents=True, exist_ok=True)
        (run_dir / "keys" / "run-token-ed25519.pub.pem").write_text(stack.ready["public_key_pem"])
        (run_dir / "service-secret").write_text(stack.ready["secret"] + "\n")
        self.cfg: Config = load_config(env={"MUNIM_RUN_DIR": str(run_dir)})
        #: A test may adjust the Frame a world's runs see (a fixture threshold); None = the tenant's own pack.
        self.adjust: Callable[[Frame], Frame] | None = None

        async def frame_source(ctx: RunContext) -> Frame | None:
            f = stack.frame(stack.world_of[ctx.tenant_id], "template")
            return self.adjust(f) if self.adjust else f

        self.client = TestClient(create_app(self.cfg, core_transport=Bridge(stack), frame_source=frame_source))

    def sweep(self, world: str) -> dict[str, Any]:
        t = self.stack.call("token", world=world, trigger="watch_sweep", scope=["*"])
        r = self.client.post(
            "/watch:sweep", headers={"x-munim-service-secret": self.stack.ready["secret"], "authorization": f"Bearer {t['token']}"}
        )
        assert r.status_code == 202, r.text
        body: dict[str, Any] = r.json()
        return body

    def mint(self, world: str, template: str, params: dict[str, Any]) -> dict[str, Any]:
        """A snapshot through core's internal route, under a sweep token of the world (as a detector mints it)."""
        t = self.stack.call("token", world=world, trigger="watch_sweep", scope=["*"])
        headers = {
            "authorization": f"Bearer {t['token']}",
            "x-munim-service-secret": self.stack.ready["secret"],
            "content-type": "application/json",
        }
        r = self.stack.call(
            "http",
            method="POST",
            path="/internal/intel/v1/snapshots",
            headers=headers,
            body=json.dumps({"template_id": template, "params": params}),
        )
        assert r["status"] in (200, 201), r
        body: dict[str, Any] = json.loads(r["body"])
        return body

    def id(self, world: str, key: str) -> str:
        return str(self.stack.call("id", world=world, key=key))

    def findings(self, pack: str) -> list[dict[str, Any]]:
        """bigint cells arrive as strings (node-postgres): the impact and its row index are ints here."""
        return [{**f, "impact": int(f["impact"]), "impact_row": int(f["impact_row"])} for f in self.stack.sql(FINDINGS, pack)]

    def count(self, q: str, *params: Any) -> int:
        return int(self.stack.sql(f"SELECT count(*)::int AS n FROM ({q}) x", *params)[0]["n"])  # noqa: S608 — the tests' own SQL
