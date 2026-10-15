"""Lane B2 gate: the ASGI entry (`munim_intel.asgi:app`) boots from the environment alone — the service secret and the
run-token public key are env vars, no `.env` and no run-directory file — and refuses as `python -m munim_intel` does."""

from __future__ import annotations

import importlib
import logging
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import SECRET
from munim_intel.config import load_config

UNAVAILABLE = {"error": {"code": "unavailable", "message": "unavailable", "reason_code": None}}


@pytest.fixture(autouse=True)
def restore_root_logging() -> Iterator[None]:
    """The entry attaches its redacting filter to the root handlers (pytest's capture handlers here): undo it after."""
    root = logging.getLogger()
    before = {h: list(h.filters) for h in root.handlers}
    handlers = list(root.handlers)
    yield
    for h in list(root.handlers):
        if h not in handlers:
            root.removeHandler(h)
    for h, filters in before.items():
        h.filters = filters


def fresh_asgi(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, env: dict[str, str]) -> ModuleType:
    empty_run_dir = tmp_path / "run"
    empty_run_dir.mkdir()
    for k in ("MUNIM_SERVICE_SECRET", "MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM", "MUNIM_INTEL_URL", "MUNIM_ENV_FILE"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("MUNIM_RUN_DIR", str(empty_run_dir))
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    sys.modules.pop("munim_intel.asgi", None)
    return importlib.import_module("munim_intel.asgi")


def test_env_only_boot_serves_and_authenticates(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, minted: dict[str, Any]) -> None:
    # The PEM as a one-line env value (literal \n), as a host's env UI stores it.
    pem = minted["public_key_pem"].strip().replace("\n", "\\n")
    asgi = fresh_asgi(monkeypatch, tmp_path, {"MUNIM_SERVICE_SECRET": SECRET, "MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM": pem})
    client = TestClient(asgi.app)
    assert client.get("/health").status_code == 200
    # Secret and key load from env: a wrong secret is 401 (not the 503 of a missing one) …
    assert client.post("/watch:sweep", headers={"x-munim-service-secret": "wrong"}).status_code == 401
    # … and a malformed token is refused by the run-token check (401), not by a missing key (503).
    other = client.post("/watch:sweep", headers={"x-munim-service-secret": SECRET, "authorization": "Bearer a.b.c"})
    assert other.status_code == 401
    assert asgi.cfg.run_token_public_key_pem() == (minted["public_key_pem"].strip() + "\n").encode()


def test_without_env_secrets_every_call_is_refused_unavailable(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    asgi = fresh_asgi(monkeypatch, tmp_path, {})
    client = TestClient(asgi.app)
    r = client.post("/watch:sweep", headers={"x-munim-service-secret": SECRET, "authorization": "Bearer a.b.c"})
    assert (r.status_code, r.json()) == (503, UNAVAILABLE)


def test_intel_url_without_a_port_takes_the_scheme_default(tmp_path: Path) -> None:
    assert load_config(env={"MUNIM_INTEL_URL": "https://intel.example.test"}, run_dir=tmp_path).port == 443
    assert load_config(env={"MUNIM_INTEL_URL": "http://intel.example.test"}, run_dir=tmp_path).port == 80
    assert load_config(env={}, run_dir=tmp_path).port == 8081
    with pytest.raises(Exception, match="MUNIM_INTEL_URL"):
        load_config(env={"MUNIM_INTEL_URL": "ftp://intel.example.test"}, run_dir=tmp_path)
