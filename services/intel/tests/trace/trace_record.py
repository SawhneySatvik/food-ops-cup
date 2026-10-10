"""Authors tests/trace/fixtures from trace_harness.SCENARIOS (run by hand after a change to the steps, tools or plugin
responses; the gates replay the result with RecordedLlm):

    uv run --frozen python tests/trace/trace_record.py
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from trace_harness import FIXTURES, Core, fan_out_then_propose, new_state, run

from munim_intel.config import load_config
from munim_intel.runtime.runner import RunFailed


async def main() -> None:
    FIXTURES.mkdir(exist_ok=True)
    for old in FIXTURES.glob("*.json"):
        old.unlink()
    cfg = load_config(env={}, run_dir=Path(tempfile.mkdtemp()))
    for name in ("clean", "tainted", "tainted_quotes", "quotes", "unknown_tool"):
        await run(name, new_state(Core()), cfg, script=True)
    try:
        await run("tool_error", new_state(Core()), cfg, script=True)
    except RunFailed:
        pass
    await fan_out_then_propose(new_state(Core()), cfg, first_branch="branch_search", script=True)
    await fan_out_then_propose(new_state(Core()), cfg, first_branch="branch_read", script=True)
    print(f"recorded {len(list(FIXTURES.glob('*.json')))} fixtures")


if __name__ == "__main__":
    asyncio.run(main())
