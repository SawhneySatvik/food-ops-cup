"""Author the recorded fixtures behind the Ask screen's suggested Cobnut questions (T-114; run by hand).

    python tests/manager/record_cobnut_ask.py serve     an authoring intel on MUNIM_INTEL_URL: every /ask runs as usual,
                                                        except that a Manager step with no fixture is authored here
    python tests/manager/record_cobnut_ask.py routes    the route.intent fixtures of the questions (date-free)

Production runs `MUNIM_MODEL_MODE=recorded` until the founder sets AI prices (F-3). An answer is replayed from
llm/recorded.py's key scheme (the sha256 of the request's projection), and a Manager request holds the run frame (the
outlets in id order, each with its business date), the open findings and the cells the read tools returned. So these
fixtures replay only on the same world on the same day (measured 15 Oct, T-114):
  - the same world = the same worldgen seed. `make seed WORLD=cobnut` picks a fresh seed each run, so two seeds differ in
    every cell (labour %, stock on hand) and even in the order of the two outlets; pass a fixed one (`node
    tools/worldgen/src/cli.ts --world=cobnut --seed=cobnut-demo`, with the tokens `make seed` mints). A fresh database
    seeded with that seed on that day, then swept once (the open findings are in the request), replays every answer;
  - the same day = the business date, "this week", "last week" and "this month" all move at midnight.
To author: seed, sweep once, run `serve` against that world (core-api asks it), ask each question once through
`POST /v1/ask`, stop it, start intel as usual, and ask again — the second answer is a replay.

How each step is authored (the way a careful model would answer, by code, never by hand): load the one skill the
question needs, read the one template that holds the answer, then `submit_answer` with segments whose every number is a
cell handle ({S1.r<i>.<column>}); prose names nothing it was not shown (an ingredient by its name cell, a kind by its
cell), and rows are chosen from the cells returned. The question texts below are the list the Ask screen offers.
"""

from __future__ import annotations

import json
import math
import re
import sys
from collections.abc import AsyncGenerator, Callable
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

INTEL = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(INTEL))

from munim_intel.decide.mimic import FIXTURES_DIR as ROUTE_FIXTURES  # noqa: E402
from munim_intel.decide.mimic import build_request, codes_for, recorded_decision  # noqa: E402
from munim_intel.decide.port import DecisionState  # noqa: E402
from munim_intel.decide.questions import ROUTE_INTENT  # noqa: E402
from munim_intel.llm.recorded import RecordedLlm, request_key  # noqa: E402
from munim_intel.manager.ask import Models  # noqa: E402

Projection = dict[str, Any]
Step = Callable[[Projection, date], LlmResponse]


def call(name: str, args: dict[str, Any]) -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))]))


def answer(segments: list[str]) -> LlmResponse:
    """The final step; no row to cite is an abstention ("cannot verify"), never an uncited sentence."""
    if not segments:
        return call("submit_answer", {"segments": [], "abstain": "missing_ref"})
    return call("submit_answer", {"segments": [{"text": s} for s in segments], "abstain": None})


def rows(p: Projection) -> list[dict[str, Any]]:
    """The rows of the last read tool's digest in the request."""
    data = [part["data"] for c in p["contents"] for part in c["parts"] if "response" in part and part["response"].startswith("read_")]
    out: list[dict[str, Any]] = data[-1]["rows"]
    return out


def each(p: Projection, sentence: str, keep: Callable[[dict[str, Any]], bool] = lambda _r: True) -> LlmResponse:
    """One segment per returned row; `@` in the sentence is that row's handle (S1.r<i>)."""
    return answer([sentence.replace("@", r["row"]) for r in rows(p) if keep(r)])


def below_reorder(p: Projection, _d: date) -> LlmResponse:
    return each(p, "{@.ingredient_name} is below its reorder level: {@.on_hand_milli} on hand against a minimum of {@.min_qty_milli}.")


def donated(p: Projection, _d: date) -> LlmResponse:
    return each(p, "Handed over this month ({@.kind}): {@.handovers} handovers, worth {@.value_at_cost_minor} at cost.")


def labour(p: Projection, _d: date) -> LlmResponse:
    return each(p, "In week {@.iso_week} labour came to {@.labour_bp} of net sales, against a target of {@.target_bp}.")


def expiring(p: Projection, _d: date) -> LlmResponse:
    sentence = "{@.at_risk_qty_milli} {@.unit} worth {@.at_risk_minor} is at risk of expiring on {@.expiry_on}."
    return each(p, sentence, lambda r: bool(r.get("at_risk_minor")))


def waste(p: Projection, _d: date) -> LlmResponse:
    """The row furthest over its usual week (the model is shown no ingredient name here, so the sentence names none)."""
    h = max(rows(p), key=lambda r: r.get("excess_minor") or 0)["row"]
    sentence = "This week's largest waste line came to {@.waste_minor} against a usual week's {@.median_minor}: {@.excess_minor} over."
    return answer([sentence.replace("@", h)])


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def month_end(d: date) -> date:
    return (d.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def last_week(d: date) -> dict[str, Any]:
    return {
        "from": (monday(d) - timedelta(days=7)).isoformat(),
        "to": (monday(d) - timedelta(days=1)).isoformat(),
        "outlet_id": None,
        "page": 0,
    }


def this_month(d: date) -> dict[str, Any]:
    return {"from": d.replace(day=1).isoformat(), "to": month_end(d).isoformat(), "outlet_id": None, "page": 0}


INV = "inventory_purchasing"
#: question -> (route.intent option, skill, read tool, its args from the business date, the answer from the rows).
QUESTIONS: dict[str, tuple[str, str, str, Callable[[date], dict[str, Any]], Step]] = {
    "Which ingredients are below their reorder level?": (
        "lookup", INV, "read_inventory_below_reorder", lambda d: {"page": 0}, below_reorder),
    "How much stock is at risk of expiring in the next three days?": (
        "lookup", INV, "read_inventory_expiry_risk", lambda d: {"days": 3, "as_of": None, "outlet_id": None, "page": 0}, expiring),
    "How did this week's waste compare with a usual week?": (
        "lookup", INV, "read_inventory_waste_week",
        lambda d: {"outlet_id": None, "week_start": monday(d - timedelta(days=1)).isoformat(), "page": 0}, waste),
    "What was labour as a share of sales last week?": ("lookup", "people", "read_people_labour_pct", last_week, labour),
    "How much food have we donated through Munim Cares this month?": ("lookup", "market", "read_cares_impact", this_month, donated),
}  # fmt: skip


def _cand(token: str, p: float) -> types.LogprobsResultCandidate:
    return types.LogprobsResultCandidate(token=token, log_probability=math.log(p))


def write_route(question: str, option: str) -> None:
    """The route.intent fixture: the option at 0.92 (band high), with logprobs, as manager_kit.write_route writes one."""
    code = next(c for c, o in codes_for(ROUTE_INTENT).items() if o == option)
    other = [c for c in codes_for(ROUTE_INTENT) if c != code][:2]
    top = [_cand(code, 0.92), _cand(other[0], 0.05), _cand(other[1], 0.03)]
    resp = LlmResponse(content=types.Content(role="model", parts=[types.Part(text=code)]))
    resp.logprobs_result = types.LogprobsResult(
        chosen_candidates=[top[0]], top_candidates=[types.LogprobsResultTopCandidates(candidates=top)]
    )
    state: DecisionState = {"question": question, "outlet_kinds": ("restaurant",), "country": "IN"}
    req = build_request(RecordedLlm(model="recorded/router", fixtures_dir=ROUTE_FIXTURES), ROUTE_INTENT, state)
    key, canonical, _ = request_key(req)
    path = ROUTE_FIXTURES / f"{key}.json"
    if not path.is_file():
        body = {"request": json.loads(canonical), "responses": [resp.model_dump(mode="json", exclude_none=True)]}
        path.write_text(json.dumps(body, ensure_ascii=False, indent=1, sort_keys=True) + "\n", "utf8")
        print(f"authored route {option} {key}")


class AskAuthor(RecordedLlm):
    """Replays a fixture that exists; authors the next step of a known question when it does not."""

    model: str = "recorded/reason"

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        key, canonical, _ = request_key(llm_request)
        path = self.fixtures_dir / f"{key}.json"
        if not path.is_file():
            p: Projection = json.loads(canonical)
            texts = [part.get("text", "") for part in p["contents"][0]["parts"]]
            question = next((q for q in QUESTIONS if q in texts), None)
            frame = re.search(r"business date (\d{4}-\d{2}-\d{2})", texts[0])
            if question is not None and frame is not None:
                _, skill, tool, args, final = QUESTIONS[question]
                d = date.fromisoformat(frame.group(1))
                step = sum(1 for c in p["contents"] if c["role"] == "model")
                resp = [call("load_skill", {"pack": skill}), call(tool, args(d)), None][step] if step < 2 else final(p, d)
                assert resp is not None
                path.write_text(
                    json.dumps({"request": p, "responses": [resp.model_dump(mode="json", exclude_none=True)]}, ensure_ascii=False, indent=1)
                    + "\n",
                    "utf8",
                )
                print(f"authored reason step {step} of {question!r}: {key}")
        async for r in super().generate_content_async(llm_request, stream):
            yield r


def serve() -> None:
    import logging

    import uvicorn

    from munim_intel.app import create_app
    from munim_intel.config import load_repo_config

    cfg = load_repo_config(INTEL.parents[1])
    assert cfg.model_mode == "recorded"

    async def models(_client: Any, _currency: str, _capped: bool = False) -> Models:
        return Models(recorded_decision(), AskAuthor())

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(create_app(cfg, ask_models=models), host=cfg.host, port=cfg.port, log_config=None)


if __name__ == "__main__":
    if sys.argv[1:] == ["routes"]:
        for q, (option, *_) in QUESTIONS.items():
            write_route(q, option)
    elif sys.argv[1:] == ["serve"]:
        serve()
    else:
        sys.exit("usage: record_cobnut_ask.py routes|serve")
