"""Shared test guards and fixtures. Every test runs recorded, with the network and `.env` both blocked."""

from __future__ import annotations

import builtins
import io
import json
import os
import shutil
import socket
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from munim_intel.config import Config, load_config
from munim_intel.llm import providers
from munim_intel.llm.recorded import RecordedFixtureMissing

INTEL = Path(__file__).resolve().parents[1]
REPO = INTEL.parents[1]
SECRET = "intel-test-service-secret-not-real"
GEMINI_KEY = "gemini-test-key-not-real-0001"
OPENROUTER_KEY = "openrouter-test-key-not-real-0002"


class NetworkBlocked(Exception):
    pass


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Recorded mode makes no network call: any socket connect or DNS lookup raises (socketpair stays, asyncio needs it)."""

    def blocked(*_: Any, **__: Any) -> Any:
        raise NetworkBlocked("network call in a test (MUNIM_MODEL_MODE=recorded)")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)


@pytest.fixture(autouse=True)
def no_retry_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    """A live call that fails with a 5xx or a 429 is started over after a jittered wait (llm/providers.retrying, C3). The
    retries still happen, so call counts show them; no test sleeps the wait."""

    async def instant(_seconds: float) -> None:
        return None

    monkeypatch.setattr(providers, "_sleep", instant)


@pytest.fixture(autouse=True)
def no_dotenv(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never read `.env` (project rule 20)."""
    real_open = builtins.open

    def guarded(file: Any, *a: Any, **k: Any) -> Any:
        if isinstance(file, str | os.PathLike) and os.path.basename(os.fspath(file)) == ".env":
            raise AssertionError(".env opened in a test")
        return real_open(file, *a, **k)

    monkeypatch.setattr(builtins, "open", guarded)
    monkeypatch.setattr(io, "open", guarded)


_MISSES_BEFORE = pytest.StashKey[int]()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_setup(item: pytest.Item) -> Iterator[None]:
    # Read before any fixture of this test is set up — module- and session-scoped ones included, which pytest builds in
    # the first requesting test's setup, before function-scoped autouse fixtures could look.
    item.stash[_MISSES_BEFORE] = RecordedFixtureMissing.raised
    yield


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]) -> Iterator[None]:
    """A recorded-fixture miss fails the test (R-E 2-C), even when the code under test swallowed it (the DecisionModel
    abstains on any error; run_agent wraps it in RunFailed and its callers degrade to a template). Misses are counted
    from the test's setup (its higher-scoped fixtures included) to its teardown. A test that misses on purpose — the
    degrade path is what it proves — says so with `@pytest.mark.fixture_miss_expected`."""
    outcome = yield
    if call.when != "teardown":
        return
    report = outcome.get_result()  # type: ignore[attr-defined]
    missed = RecordedFixtureMissing.raised - item.stash.get(_MISSES_BEFORE, RecordedFixtureMissing.raised)
    if missed and item.get_closest_marker("fixture_miss_expected") is None and report.passed:
        report.outcome = "failed"
        report.longrepr = f"{missed} recorded fixture miss(es) in a test not marked fixture_miss_expected"


@pytest.fixture(scope="session")
def minted() -> dict[str, Any]:
    """Tokens signed by core-api's own signJwt (tests/fixtures/mint_tokens.mts). Fails — never skips — without node."""
    node = shutil.which("node")
    assert node, "node is required: the run-token tests use core-api's real signer"
    out = subprocess.run(
        [node, str(INTEL / "tests" / "fixtures" / "mint_tokens.mts")], capture_output=True, text=True, check=True, timeout=60
    )
    data: dict[str, Any] = json.loads(out.stdout)
    return data


def make_run_dir(root: Path, public_key_pem: str) -> Path:
    (root / "keys").mkdir(parents=True)
    (root / "keys" / "run-token-ed25519.pub.pem").write_text(public_key_pem)
    (root / "service-secret").write_text(SECRET + "\n")
    return root


@pytest.fixture
def cfg(tmp_path: Path, minted: dict[str, Any]) -> Iterator[Config]:
    run_dir = make_run_dir(tmp_path / "run", minted["public_key_pem"])
    yield load_config(env={"MUNIM_RUN_DIR": str(run_dir), "GEMINI_API_KEY": GEMINI_KEY, "OPENROUTER_API_KEY": OPENROUTER_KEY})
