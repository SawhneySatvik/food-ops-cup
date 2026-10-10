"""Gate (R36): the lock holds google-adk exactly 2.11.0, never litellm, never a forbidden ADK extra — and is fresh."""

from __future__ import annotations

import shutil
import subprocess
import tomllib
from typing import Any

from conftest import INTEL, REPO

FORBIDDEN_EXTRAS = {"eval", "extensions", "all", "test"}
LOCK = REPO / "uv.lock"


def lock_violations(text: str) -> list[str]:
    lock = tomllib.loads(text)
    found: list[str] = []

    def walk(node: Any, where: str) -> None:
        if isinstance(node, dict):
            name = node.get("name")
            if name == "litellm":
                found.append(f"litellm at {where}")
            if name == "google-adk":
                extras = set(node.get("extra", [])) | set(node.get("extras", []))
                if extras & FORBIDDEN_EXTRAS:
                    found.append(f"google-adk[{','.join(sorted(extras & FORBIDDEN_EXTRAS))}] at {where}")
            for k, v in node.items():
                walk(v, f"{where}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{where}[{i}]")

    walk(lock, "uv.lock")
    adk = [p.get("version") for p in lock.get("package", []) if p.get("name") == "google-adk"]
    if adk != ["2.11.0"]:
        found.append(f"google-adk must be locked once at 2.11.0, found {adk}")
    return found


def test_the_lock_is_clean() -> None:
    text = LOCK.read_text("utf8")
    packages = tomllib.loads(text)["package"]
    print(f"uv.lock: {len(packages)} packages, violations {lock_violations(text)}")
    assert len(packages) > 10
    assert lock_violations(text) == []


def test_the_check_sees_each_planted_violation() -> None:
    clean = LOCK.read_text("utf8")
    planted = {
        "litellm package": clean
        + '\n[[package]]\nname = "litellm"\nversion = "1.84.0"\nsource = { registry = "https://pypi.org/simple" }\n',
        "litellm dependency": clean.replace('    { name = "google-adk" },', '    { name = "google-adk" },\n    { name = "litellm" },', 1),
        "adk[extensions]": clean.replace('    { name = "google-adk" },', '    { name = "google-adk", extra = ["extensions"] },', 1),
        "adk[eval] requested": clean.replace(
            '{ name = "google-adk", specifier = "==2.11.0" }', '{ name = "google-adk", extras = ["eval"], specifier = "==2.11.0" }'
        ),
        "adk 2.10.0": clean.replace('name = "google-adk"\nversion = "2.11.0"', 'name = "google-adk"\nversion = "2.10.0"'),
        "empty lock": "version = 1\n",
    }
    for label, text in planted.items():
        assert text != clean, f"plant '{label}' did not change the lock"
        assert lock_violations(text), f"plant '{label}' passed the lockfile check"


def test_the_lock_matches_pyproject() -> None:
    uv = shutil.which("uv")
    assert uv, "uv is required"
    r = subprocess.run([uv, "lock", "--check", "--offline"], cwd=INTEL, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
