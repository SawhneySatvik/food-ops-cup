"""T-042: a run's trace batches round-trip to the real core `traces:batch` on embedded Postgres, gapless.

The run is the recorded `clean` scenario (flush every 5 events, so 2 batches); the bodies intel sent are replayed by
core_roundtrip.mts through core-api's own app, run token and RLS into `intel.trace_event`, then replayed again as a
retried flush. Fails — never skips — without node (as the run-token tests do).
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path

from trace_harness import Core, run

from munim_intel.config import load_config
from munim_intel.runtime.state import Budget, RunState
from munim_intel.trace.buffer import TraceBuffer

HERE = Path(__file__).resolve().parent


def test_a_runs_batches_round_trip_to_core_on_embedded_postgres_gapless(tmp_path: Path) -> None:
    core = Core()
    state = RunState(traces=TraceBuffer(core.client().write_traces, flush_every=5), budget=Budget())
    state.tool_pack.update({"read_sales": "finance", "propose_price": "finance"})
    asyncio.run(run("clean", state, load_config(env={}, run_dir=tmp_path)))
    bodies = tmp_path / "bodies.json"
    bodies.write_text("[" + ",".join(b.decode() for b in core.bodies) + "]")

    node = shutil.which("node")
    assert node, "node is required: the round-trip runs core-api's real traces:batch"
    out = subprocess.run([node, str(HERE / "core_roundtrip.mts"), str(bodies)], capture_output=True, text=True, timeout=180)
    assert out.returncode == 0, out.stderr[-2000:]
    got = json.loads(out.stdout)
    first = [(r["status"], r["body"]) for r in got["first"]]
    retry = [(r["status"], r["body"]["inserted"]) for r in got["retry"]]
    rows = [(r["seq"], r["actor"], r["kind"]) for r in got["rows"]]
    print("first:", first, "\nretry:", retry, "\nrows:", rows)
    # Hand count from SCENARIOS["clean"]: 9 events (route, subagent_start, 3 x tool_call + tool_result, subagent_end),
    # flushed at 5 and at the end.
    assert first == [(201, {"inserted": 5, "last_seq": 5}), (201, {"inserted": 4, "last_seq": 9})]
    assert retry == [(201, 0), (201, 0)]
    assert [s for s, _, _ in rows] == list(range(1, 10))
    assert {a for _, a, _ in rows} == {"manager", "specialist:finance"} and sum(a == "specialist:finance" for _, a, _ in rows) == 6
