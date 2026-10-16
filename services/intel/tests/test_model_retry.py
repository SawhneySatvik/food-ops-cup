"""C3 (found live, 16 Oct): flash-lite answered a 5xx twice in three Asks ("Cannot verify") and once lost a supplier's quote
extraction (`no_passing_quote`). A live Gemini call that fails with a 5xx or a 429 is started over: at most twice in all, a 429
at most once, after a jittered wait, all inside the role's own timeout. Offline: the transport is faked where google-genai hands
the request to HTTP (`BaseApiClient._async_request`, as tests/test_gemini_request.py does), so ADK, google-genai and the
provider class run as in production; nothing reaches the network and nothing waits (the wait is replaced and recorded).

Expected counts are the rule's, typed by hand: 503, 503, ok = 3 transport calls and an answer; 503 x3 = 3 calls and the error
(the call abstains: no crash, the exception carries the `abstained` label); 429, ok = 2 calls; 429, 429 = 2 calls and the error.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from google.adk.models.llm_request import LlmRequest
from google.genai import _api_client, types
from google.genai.errors import ClientError, ServerError

from conftest import GEMINI_KEY
from munim_intel.llm import providers
from munim_intel.llm.providers import TimedGemini
from munim_intel.trace.served import KEY

OK_BODY = json.dumps(
    {
        "candidates": [{"content": {"role": "model", "parts": [{"text": "A"}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 1, "totalTokenCount": 4},
    }
)


def err(code: int) -> Exception:
    body = {"error": {"code": code, "status": "X", "message": "m"}}
    return ServerError(code, body) if code >= 500 else ClientError(code, body)


class Transport:
    """Answers each call from `script`: an exception is raised, "ok" returns a response, "hang" never answers."""

    def __init__(self, script: list[Any]) -> None:
        self.script, self.calls = script, 0

    async def __call__(self) -> Any:
        step = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        if step == "hang":
            await asyncio.sleep(60)
        if step == "ok":
            return _api_client.HttpResponse(headers={}, response_stream=[OK_BODY])
        raise step


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """The waits asked for before each retry (jitter pinned at x1 so the base values show); none is slept."""
    asked: list[float] = []

    async def no_sleep(seconds: float) -> None:
        asked.append(seconds)

    monkeypatch.setattr(providers, "_sleep", no_sleep)
    monkeypatch.setattr(providers, "_jitter", lambda _lo, _hi: 1.0)
    return asked


def call(monkeypatch: pytest.MonkeyPatch, script: list[Any], timeout_s: float = 60.0) -> tuple[Transport, list[Any], Exception | None]:
    transport = Transport(script)

    async def fake(_self: Any, http_request: Any, http_options: Any = None, stream: bool = False) -> Any:
        return await transport()

    monkeypatch.setattr(_api_client.BaseApiClient, "_async_request", fake)
    llm = TimedGemini(model="gemini-3.5-flash-lite", client_kwargs={"api_key": GEMINI_KEY}, timeout_s=timeout_s)
    req = LlmRequest(model=llm.model, contents=[types.Content(role="user", parts=[types.Part(text="q")])])

    async def go() -> list[Any]:
        return [r async for r in llm.generate_content_async(req)]

    try:
        return transport, asyncio.run(go()), None
    except Exception as e:  # noqa: BLE001 — the test reads what the caller would see
        return transport, [], e


def answered(responses: list[Any]) -> list[str]:
    return [p.text for r in responses for p in r.content.parts]


def test_two_5xx_then_an_answer_is_an_answer(monkeypatch: pytest.MonkeyPatch, waits: list[float]) -> None:
    transport, responses, error = call(monkeypatch, [err(503), err(500), "ok"])
    assert error is None and answered(responses) == ["A"]
    assert (transport.calls, waits) == (3, [0.5, 1.0])


def test_three_5xx_abstains_without_a_crash(monkeypatch: pytest.MonkeyPatch, waits: list[float]) -> None:
    transport, responses, error = call(monkeypatch, [err(503)])
    assert (transport.calls, responses, waits) == (3, [], [0.5, 1.0])
    assert isinstance(error, ServerError) and getattr(error, KEY) == "abstained"


def test_a_429_is_retried_once_after_a_short_wait(monkeypatch: pytest.MonkeyPatch, waits: list[float]) -> None:
    transport, responses, error = call(monkeypatch, [err(429), "ok"])
    assert error is None and answered(responses) == ["A"]
    assert (transport.calls, waits) == (2, [2.0])
    transport, responses, error = call(monkeypatch, [err(429)])
    assert (transport.calls, responses) == (2, []) and isinstance(error, ClientError) and error.code == 429


def test_two_retries_in_all_whichever_errors_they_answer(monkeypatch: pytest.MonkeyPatch, waits: list[float]) -> None:
    transport, _, error = call(monkeypatch, [err(502), err(429), err(503), "ok"])
    assert (transport.calls, waits) == (3, [0.5, 2.0]) and isinstance(error, ServerError) and error.code == 503


def test_what_is_not_transient_is_not_retried(monkeypatch: pytest.MonkeyPatch, waits: list[float]) -> None:
    transport, _, error = call(monkeypatch, [err(400), "ok"])
    assert (transport.calls, waits) == (1, []) and isinstance(error, ClientError) and error.code == 400


def test_the_retries_sit_inside_the_role_timeout(monkeypatch: pytest.MonkeyPatch, waits: list[float]) -> None:
    """A 5xx, then a retry that never answers: the role's timeout ends the call (a timeout is not retried)."""
    transport, _, error = call(monkeypatch, [err(503), "hang"], timeout_s=0.3)
    assert transport.calls == 2 and isinstance(error, TimeoutError) and getattr(error, KEY) == "abstained"
