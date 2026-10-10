"""Gate: the smoke run end to end — core-signed token -> RunContext -> ADK run on RecordedLlm -> echo tool closed
over the context — with the network blocked, and byte-identical across two fresh processes."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from typing import Any

from fastapi.testclient import TestClient

from conftest import INTEL, SECRET
from munim_intel.app import create_app
from munim_intel.config import Config
from munim_intel.llm.recorded import RecordedLlm


def smoke(cfg: Config, token: str, secret: str = SECRET) -> Any:
    return TestClient(create_app(cfg)).post(
        "/smoke", json={"text": "ping"}, headers={"x-munim-service-secret": secret, "authorization": f"Bearer {token}"}
    )


def test_smoke_run_end_to_end_with_no_network(cfg: Config, minted: dict[str, Any]) -> None:
    before = RecordedLlm.calls
    r = smoke(cfg, minted["tokens"]["valid"])
    print(f"smoke: {r.status_code} {r.text}; recorded replays {RecordedLlm.calls - before}")
    assert r.status_code == 200
    run_id = minted["claims"]["valid"]["run_id"]
    assert r.json() == {
        "run_id": run_id,
        "tool_calls": ["echo"],
        "tool_context": [{"run_id": run_id, "outlet_scope": ["*"]}],
        "echo_text_sha256": [hashlib.sha256(b"ping").hexdigest()],
        "final_text_sha256": hashlib.sha256(b"done").hexdigest(),
    }
    assert RecordedLlm.calls - before == 2


def test_an_outlet_scoped_run_reaches_the_tool_with_its_scope(cfg: Config, minted: dict[str, Any]) -> None:
    r = smoke(cfg, minted["tokens"]["ask"])
    assert r.status_code == 200
    assert r.json()["tool_context"] == [{"run_id": minted["claims"]["ask"]["run_id"], "outlet_scope": [minted["outlet"]]}]


def test_refusals_are_uniform(cfg: Config, minted: dict[str, Any]) -> None:
    bodies = {
        smoke(cfg, minted["tokens"][t], secret).content
        for t, secret in [("valid", "wrong"), ("other_key", SECRET), ("expired", SECRET), ("tampered_to_b", SECRET)]
    }
    assert len(bodies) == 1 and b"unauthenticated" in next(iter(bodies))


def test_a_recorded_run_is_byte_identical_twice(minted: dict[str, Any]) -> None:
    stdin = json.dumps({"token": minted["tokens"]["valid"], "public_key_pem": minted["public_key_pem"], "secret": SECRET})
    outs = [
        subprocess.run(
            [sys.executable, str(INTEL / "tests" / "fixtures" / "smoke_once.py")],
            input=stdin.encode(),
            capture_output=True,
            check=True,
            timeout=120,
        ).stdout
        for _ in range(2)
    ]
    print(f"run 1: {outs[0]!r}")
    assert outs[0].startswith(b"200\n")
    assert outs[0] == outs[1]
