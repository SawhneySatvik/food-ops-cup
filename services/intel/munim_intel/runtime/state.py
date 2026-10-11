"""RunState: the per-context run object a Runner carries — the Manager's, and one per fan-out branch (ADR-014 §6.3;
T-053 deviation: a branch's own RunState keeps §3.4's per-branch caps over the run's shared HandleTable and TraceBuffer).

It holds the budget, the taint flag, the handle table and the TraceBuffer. Taint lives here and nowhere else
(review B1): a flag in one Runner's session state would let a branch that read untrusted text hand prose to an
untainted Manager that can propose. A branch's taint reaches the Manager's RunState through `BranchReport.tainted`,
which the plugin ORs into the run when fan_out returns; a branch starts tainted when the run already is.

The actor of the code running now is a ContextVar, not a field: branches run as concurrent tasks and each task
carries its own copy, so a branch's traces say `branch:<pack>` while the Manager's say `manager` (ADK's agent name
is the constant `munim` and cannot carry it).
"""

from __future__ import annotations

import re
from collections import Counter
from contextvars import ContextVar
from dataclasses import dataclass, field

from munim_intel.trace.buffer import TraceBuffer
from munim_intel.trace.spend import Meter

#: Ledger R45 F8 — the eight specialists, one per pack (hand list; the registry is packages/contracts/src/intel/specialists.ts).
PACKS = ("catalogue", "kitchen", "inventory_purchasing", "finance", "people", "customers", "compliance", "market")
#: 04-agent-framework §7 actor labels for intel runs.
ACTOR_LABEL = re.compile(rf"^(manager|brief|(specialist|branch|watcher):({'|'.join(PACKS)}))$")

ACTOR: ContextVar[str] = ContextVar("munim_actor", default="manager")


def check_actor(label: str) -> str:
    if not ACTOR_LABEL.match(label):
        raise ValueError("actor is not a known label")
    return label


@dataclass
class Budget:
    """Per-run model and tool caps. Defaults are ADR-014 §3.4 "ask, single agent" (provisional; re-based by T-059).
    These are the run's own caps; the month's money is core's (`RunState.meter` posts each call's spend)."""

    max_model_calls: int = 8
    max_input_tokens: int = 100_000
    max_tool_calls: int = 10
    model_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: int = 0

    def models_exhausted(self) -> bool:
        return self.model_calls >= self.max_model_calls or self.input_tokens >= self.max_input_tokens


@dataclass
class RunState:
    traces: TraceBuffer
    budget: Budget = field(default_factory=Budget)
    #: Set once any untrusted text (search, wiki, supplier reply, tainted thread turn) entered any context of the run;
    #: never cleared. Code outside the plugin (extractor, thread excerpt) sets it directly.
    tainted: bool = False
    #: Handle -> canonical ref. One table per run, shared counter (review minor 6); filled by T-082a.
    handles: dict[str, str] = field(default_factory=dict)
    #: Tool name -> pack, for the tools a loaded skill binds (T-082a's PackToolset registers them). In the Manager's
    #: context their traces carry `specialist:<pack>`.
    tool_pack: dict[str, str] = field(default_factory=dict)
    #: Tool name -> calls refused for invalid arguments (§5.3: one retry, then the tool is disabled for the run).
    invalid_args: Counter[str] = field(default_factory=Counter)
    #: Plugin callback name -> times fired. The fired-callback gate reads it: a misspelt hook stays at 0.
    fired: Counter[str] = field(default_factory=Counter)
    #: Where this context's model calls are charged (W3 close ruling): one row per provider call, posted with the traces.
    #: None only where no provider is ever called (template paths) or in offline tests that do not measure spend.
    meter: Meter | None = None
