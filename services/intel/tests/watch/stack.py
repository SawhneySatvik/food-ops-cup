"""The T-043 end-to-end stack from Python: core_stack.mts (embedded Postgres + the real core-api, seeded by worldgen)
as a subprocess, spoken to over stdin/stdout JSON lines. intel's tests block sockets, so the bridge transport hands
each InternalClient request to core-api's `app.request` in-process — no port is opened on the intel side."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import httpx

from munim_intel.watch.frame import Frame, Narration, frame_from_pack

HERE = Path(__file__).resolve().parent


class Stack:
    def __init__(self, days: int, worlds: list[str]) -> None:
        node = shutil.which("node")
        assert node, "node is required: the T-043 end-to-end gates run core-api's real internal API"
        self.proc = subprocess.Popen(  # noqa: S603 — fixed argv of our own fixture
            [node, str(HERE / "core_stack.mts"), str(days), *worlds],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self.ready = self._read("ready")
        self.tenants: dict[str, str] = self.ready["tenants"]
        self.world_of = {t: w for w, t in self.tenants.items()}

    def _read(self, key: str) -> Any:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            if line.startswith("{"):
                msg = json.loads(line)
                if key in msg:
                    return msg[key] if key != "ready" else msg
        raise AssertionError(f"core_stack.mts exited ({self.proc.wait()}) before answering")

    def call(self, op: str, **args: Any) -> Any:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps({"op": op, **args}) + "\n")
        self.proc.stdin.flush()
        return self._read("ok")

    def sql(self, q: str, *params: Any) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = self.call("sql", q=q, params=list(params))
        return rows

    def frame(self, world: str, narration: Narration) -> Frame:
        f = self.call("frame", world=world, narration=narration)
        return frame_from_pack(f["pack"], f["outlets"], f["narration"])

    def stop(self) -> None:
        if self.proc.poll() is None:
            assert self.proc.stdin is not None
            self.proc.stdin.write(json.dumps({"op": "stop"}) + "\n")
            self.proc.stdin.flush()
            self.proc.wait(timeout=60)
        assert self.proc.returncode == 0, f"core_stack.mts exited {self.proc.returncode}"


class Bridge(httpx.AsyncBaseTransport):
    """An httpx transport whose every request is answered by core-api's app, in-process, inside the stack."""

    def __init__(self, stack: Stack) -> None:
        self.stack = stack

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = (await request.aread()).decode() or None
        out = self.stack.call(
            "http", method=request.method, path=request.url.raw_path.decode(), headers=dict(request.headers.items()), body=body
        )
        return httpx.Response(out["status"], content=out["body"].encode(), headers={"content-type": "application/json"})
