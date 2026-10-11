"""Writes the RecordedDecision fixtures (`munim_intel/decide/fixtures/`). Run from services/intel:

    uv run --frozen python -m tests.decide.make_fixtures

The responses are SYNTHETIC: what a router model is assumed to answer, written here as option *codes* with a
probability spread, not taken from a live model. Replaying them proves the plumbing (request builder, constraint,
code mapping, logprob renormalisation, re-validation), never model quality (ADR-014 §4.5).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.decide.mimic import FIXTURES_DIR, build_request
from munim_intel.decide.port import DecisionQuestion, DecisionState
from munim_intel.decide.questions import MAP_COLUMNS, ROUTE_INTENT
from munim_intel.llm.recorded import RecordedLlm, request_key

LLM = RecordedLlm(model="recorded/router", fixtures_dir=FIXTURES_DIR)
KINDS = ("restaurant",)


def route(question: str) -> DecisionState:
    return {"question": question, "outlet_kinds": KINDS, "country": "IN"}


# (question, the code the model "answers", that code's probability before renormalisation). The rest of the mass is
# spread over two other codes and one non-code token, so renormalisation has work to do.
ROUTE: list[tuple[str, str, float]] = [
    ("What were total sales yesterday?", "A", 0.93),
    ("How much paneer is in stock at the Koramangala kitchen?", "A", 0.88),
    ("@Finance show me last week's payouts from the delivery apps", "A", 0.81),
    ("Who is rostered for Saturday dinner?", "A", 0.90),
    ("Why did food cost go up this week?", "B", 0.86),
    ("@Kitchen why are ticket times slow on weekends?", "B", 0.84),
    ("What does the short payout finding mean?", "B", 0.91),
    ("Why is the butter chicken margin negative?", "B", 0.79),
    ("Dig into why our margin fell this month across all outlets", "C", 0.83),
    ("@Inventory find out where the extra chicken waste is coming from over the last three months", "C", 0.77),
    ("Work out step by step what is driving the drop in repeat customers", "C", 0.80),
    ("Look into why labour cost keeps rising every month since June", "C", 0.74),
    ("Order 20 kg of onions from our usual supplier", "D", 0.95),
    ("@Menu raise the price of masala dosa to match the new cost", "D", 0.92),
    ("Make next week's roster for the Indiranagar outlet", "D", 0.89),
    ("@Finance draft a dispute for the missing delivery app payout", "D", 0.87),
    ("Certify that our GST filing for September is correct", "E", 0.94),
    ("@Compliance can you guarantee we pass the food safety audit?", "E", 0.82),
    ("Sign off the books for the month as accurate", "E", 0.90),
    ("Confirm in writing that the payroll is legally compliant", "E", 0.76),
    ("Write me a poem about biryani", "F", 0.96),
    ("Who won the cricket match last night?", "F", 0.97),
    ("@Market what's the weather in Goa this weekend?", "F", 0.85),
    ("Help me with my child's maths homework", "F", 0.95),
]

# Planted edge cases (the gates name them by question text).
PLANTED_OUT_OF_ENUM = "PLANTED: the model answers a code outside the enum"
PLANTED_NO_LOGPROBS = "PLANTED: the provider returns no logprobs"
PLANTED_LOW = "PLANTED: the model is unsure"
#: map.columns twin of PLANTED_NO_LOGPROBS (T-081 dm-1): map.columns does not accept an unscored answer.
PLANTED_MAP_NO_LOGPROBS = "PLANTED: no logprobs for this header"

POS_BILLS_HEADERS = ("Bill No", "Bill Date", "Outlet Name", "Item Code", "Qty", "Rate", "Line Amount", "Remarks")
# header -> (code, p). Codes index MAP_COLUMNS["pos_bills"].options (bill_no = A … currency = Y, ignore = Z).
MAP: list[tuple[str, str, float]] = [
    ("Bill No", "A", 0.97),
    ("Bill Date", "B", 0.95),
    ("Outlet Name", "D", 0.92),
    ("Item Code", "J", 0.90),
    ("Qty", "L", 0.96),
    ("Rate", "M", 0.81),
    ("Line Amount", "P", 0.78),
    ("Remarks", "Z", 0.55),  # below map.columns' threshold → left unmapped for a person
]


def _cand(token: str, p: float) -> types.LogprobsResultCandidate:
    return types.LogprobsResultCandidate(token=token, log_probability=math.log(p))


def response(code: str, p: float | None, other: tuple[str, str]) -> LlmResponse:
    lr = None
    if p is not None:
        rest = 1 - p
        top = [_cand(code, p), _cand(other[0], rest * 0.5), _cand(other[1], rest * 0.3), _cand("\n", rest * 0.2)]
        lr = types.LogprobsResult(chosen_candidates=[_cand(code, p)], top_candidates=[types.LogprobsResultTopCandidates(candidates=top)])
    return LlmResponse(
        content=types.Content(role="model", parts=[types.Part(text=code)]),
        logprobs_result=lr,
    )


def write(q: DecisionQuestion, state: DecisionState, resp: LlmResponse) -> None:
    req = build_request(LLM, q, state)
    key, canonical, _ = request_key(req)
    # A rough count (4 chars/token) so the replay reports a plausible input size; measured counts come from T-059.
    resp.usage_metadata = types.GenerateContentResponseUsageMetadata(prompt_token_count=len(canonical) // 4)
    body = {"request": json.loads(canonical), "responses": [resp.model_dump(mode="json", exclude_none=True)]}
    (FIXTURES_DIR / f"{key}.json").write_text(json.dumps(body, ensure_ascii=False, indent=1, sort_keys=True) + "\n", "utf8")


def others(code: str, pool: str) -> tuple[str, str]:
    rest = [c for c in pool if c != code]
    return rest[0], rest[1]


def main() -> None:
    FIXTURES_DIR.mkdir(exist_ok=True)
    for old in Path(FIXTURES_DIR).glob("*.json"):
        old.unlink()
    for question, code, p in ROUTE:
        write(ROUTE_INTENT, route(question), response(code, p, others(code, "ABCDEF")))
    write(ROUTE_INTENT, route(PLANTED_OUT_OF_ENUM), response("Q", 0.9, ("A", "B")))
    write(ROUTE_INTENT, route(PLANTED_NO_LOGPROBS), response("A", None, ("B", "C")))
    write(ROUTE_INTENT, route(PLANTED_LOW), response("C", 0.40, ("B", "A")))
    q = MAP_COLUMNS["pos_bills"]
    for header, code, p in MAP:
        write(q, {"header": header, "headers": POS_BILLS_HEADERS}, response(code, p, others(code, "ABZ")))
    write(q, {"header": PLANTED_MAP_NO_LOGPROBS, "headers": POS_BILLS_HEADERS}, response("L", None, ("A", "B")))


if __name__ == "__main__":
    main()
