"""Shared by the Customers (T-049) and Compliance (T-050) pack gates. Imported by both test directories.

- Offline: T-043's in-memory core (tests/watch/test_watch.py `FakeCore`), with one detector run at a time.
- End to end: T-043's real core-api stack (tests/watch/stack.py), worldgen at the 100-day gate profile. A `WatchRun` is
  driven over the bridge with this pack's detectors and a frame the test chooses. `/watch:sweep` would run every pack
  at core's pinned date. The seed-day coupon plants need the seed day instead (see `PackStack.sweep`).
- Independent sources: the answer keys, the pack md §4 tables, the ontology (generated from the 0021 templates), the
  number-word data (packages/contracts/src/shared/grammar).
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any, TypeVar

from conftest import INTEL, REPO

sys.path.insert(0, str(INTEL / "tests" / "watch"))

from stack import Bridge, Stack  # noqa: E402
from test_watch import FakeCore, frame, run  # noqa: E402

from munim_intel.config import Config, load_config  # noqa: E402
from munim_intel.detect import DetectorSpec  # noqa: E402
from munim_intel.runtime.context import RunContext, load_public_key, verify_run_token  # noqa: E402
from munim_intel.runtime.internal_client import InternalClient  # noqa: E402
from munim_intel.watch.frame import Frame  # noqa: E402
from munim_intel.watch.pipeline import Report, WatchRun  # noqa: E402

__all__ = ["FakeCore", "frame", "run", "Bridge", "Stack"]

T = TypeVar("T")

WORLDS = ["restaurant_group", "cloud_kitchen", "store", "au_outlet"]
WORLD_OF = {"RG": "restaurant_group", "CK": "cloud_kitchen", "ST": "store", "AU": "au_outlet"}
#: tools/worldgen/test/profile.ts: the gate profile (fixed outlet-local "today", 100 days of history).
AS_OF = date(2026, 10, 10)
DAYS = 100

FINDINGS = """SELECT f.tenant_id::text, f.id::text, f.pack, f.type, f.severity, f.outlet_ids::text[] AS outlet_ids, f.dedupe_key,
                     f.confidence_bp, f.envelope, f.impact_snapshot_id::text AS snapshot_id, f.impact_row,
                     (s.rows -> f.impact_row ->> f.impact_column)::bigint AS impact, s.rows AS snapshot_rows
                FROM intel.finding f JOIN evidence.snapshot s ON s.tenant_id = f.tenant_id AND s.id = f.impact_snapshot_id
               WHERE f.pack = $1 ORDER BY f.dedupe_key"""
ACTORS = """SELECT DISTINCT t.actor FROM intel.trace_event t JOIN intel.run r ON r.tenant_id = t.tenant_id AND r.id = t.run_id
             WHERE r.trigger = 'watch_sweep' AND t.actor LIKE 'watcher:%'"""


def answer_key(plant: str) -> dict[str, Any]:
    key = json.loads((REPO / "tools" / "worldgen" / "answer-key" / f"{WORLD_OF[plant[:2]]}.json").read_text("utf8"))
    entry: dict[str, Any] = next(p for p in key["problems"] if p["id"] == plant)
    return entry


def detector_map() -> dict[str, Any]:
    out: dict[str, Any] = json.loads((REPO / "tools" / "worldgen" / "answer-key" / "detector-map.json").read_text("utf8"))
    return out


def pack_detector_ids(md: str) -> set[str]:
    """The detector ids of a pack doc's §4 table (first cell of each row)."""
    text = (REPO / "docs" / "plan" / "packs" / md).read_text("utf8")
    section = text.split("## 4 · Detectors", 1)[1].split("\n## ", 1)[0]
    return set(re.findall(r"^\| `([a-z_]+\.[a-z_]+)` \|", section, flags=re.M))


def ontology_function(template: str) -> dict[str, Any]:
    ont = json.loads((REPO / "packages" / "contracts" / "generated" / "ontology.json").read_text("utf8"))
    fn: dict[str, Any] = next(f for f in ont["functions"] if f["id"] == template)
    return fn


def number_words() -> list[str]:
    data = json.loads((REPO / "packages" / "contracts" / "src" / "shared" / "grammar" / "number-words.json").read_text("utf8"))
    words: list[str] = data["english_cardinals"]
    return words


def narration_problems(spec: DetectorSpec) -> list[str]:
    """What core's number grammar would refuse in a template narration, plus slots that are not template columns."""
    columns = {c["name"] for c in ontology_function(spec.template)["columns"]}
    slots = re.findall(r"\{([a-z_0-9]+)\}", spec.narration)
    prose = re.sub(r"\{[a-z_0-9]+\}", " ", spec.narration)
    out = [f"digit {m!r}" for m in re.findall(r"\d", prose)]
    out += [f"number word {w!r}" for w in number_words() if re.search(rf"\b{re.escape(w)}\b", prose, flags=re.I)]
    out += [f"slot {s!r} is not a {spec.template} column" for s in slots if s not in columns]
    if not slots:
        out.append("no slot")
    return out


def offline(spec: DetectorSpec, rows: list[dict[str, Any]], code: str = "IN", kind: str = "restaurant") -> FakeCore:
    core = FakeCore({spec.template: rows})
    run(core, frame(code, kind), {spec.pack: [spec]})
    return core


class PackStack:
    """The T-043 stack plus a watcher that runs chosen detectors with a chosen frame."""

    def __init__(self, run_dir: Path) -> None:
        self.stack = Stack(DAYS, WORLDS)
        (run_dir / "keys").mkdir(parents=True, exist_ok=True)
        (run_dir / "keys" / "run-token-ed25519.pub.pem").write_text(self.stack.ready["public_key_pem"])
        (run_dir / "service-secret").write_text(self.stack.ready["secret"] + "\n")
        self.cfg: Config = load_config(env={"MUNIM_RUN_DIR": str(run_dir)})
        self.tenants: dict[str, str] = self.stack.tenants

    def stop(self) -> None:
        self.stack.stop()

    def id(self, world: str, key: str) -> str:
        return str(self.stack.call("id", world=world, key=key))

    def sql(self, q: str, *params: Any) -> list[dict[str, Any]]:
        return self.stack.sql(q, *params)

    def frame(self, world: str, business_date: date, thresholds: dict[str, dict[str, int]] | None = None) -> Frame:
        """The tenant's own pack (thresholds, ladder) with every outlet's business date set to `business_date`;
        `thresholds` replaces named detectors' thresholds (gate-local, stated by the caller)."""
        f = self.stack.frame(world, "template")
        detectors = {**f.detectors, **(thresholds or {})}
        return replace(f, detectors=detectors, outlets=tuple(replace(o, business_date=business_date) for o in f.outlets))

    def sweep(self, world: str, specs: list[DetectorSpec], f: Frame) -> Report:
        """One watcher run over every outlet of the tenant (scope `*`), through core's real internal API."""

        async def go(client: InternalClient, ctx: RunContext) -> Report:
            return await WatchRun(ctx, client, f, self.cfg).run({specs[0].pack: specs})

        return self.with_client(world, go)

    def with_client(self, world: str, fn: Callable[[InternalClient, RunContext], Awaitable[T]]) -> T:
        """Runs `fn` with an internal client under a fresh sweep token of the tenant (scope `*`)."""
        t = self.stack.call("token", world=world, trigger="watch_sweep", scope=["*"])
        ctx = verify_run_token(t["token"], load_public_key(self.cfg.run_token_public_key_pem()))

        async def go() -> T:
            client = InternalClient(ctx, base_url=self.cfg.core_url, service_secret=self.cfg.service_secret(), transport=Bridge(self.stack))
            try:
                return await fn(client, ctx)
            finally:
                await client.aclose()

        return asyncio.run(go())

    def findings(self, pack: str, world: str | None = None) -> list[dict[str, Any]]:
        rows = self.sql(FINDINGS, pack)
        return [r for r in rows if world is None or r["tenant_id"] == self.tenants[world]]
