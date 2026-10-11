"""pg_bridge.mts from Python: embedded Postgres + core-api's batch writers and app as a subprocess, spoken to in JSON
lines. Writes are core's batch writers; the service-role reader is the real InternalClient over core's real
`graph:query` route (run token + service secret, munim_svc); the admin reader runs core's own graph statement as the
superuser, so only the templates' tenant predicates isolate there."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import httpx

from munim_intel.contracts_gen.models import InternalBatchResponse, InternalEdgesBatchRequest, InternalEntitiesBatchRequest
from munim_intel.graph import Row
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient

HERE = Path(__file__).resolve().parent


class Bridge:
    def __init__(self) -> None:
        node = shutil.which("node")
        assert node, "node is required: the T-058 gates run core-api's batch writers on embedded Postgres"
        self.proc = subprocess.Popen(  # noqa: S603 — fixed argv of our own fixture
            [node, str(HERE / "pg_bridge.mts")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self.ready: dict[str, dict[str, str]] = self._read("ready")

    def _read(self, key: str) -> Any:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            if line.startswith("{"):
                msg = json.loads(line)
                if "error" in msg:
                    raise AssertionError(f"bridge refused: {msg['error']}")
                if key in msg:
                    return msg[key]
        raise AssertionError(f"pg_bridge.mts exited ({self.proc.wait()}) before answering")

    def call(self, op: str, **args: Any) -> Any:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps({"op": op, **args}) + "\n")
        self.proc.stdin.flush()
        return self._read("ok")

    def stop(self) -> None:
        if self.proc.poll() is None:
            assert self.proc.stdin is not None
            self.proc.stdin.write(json.dumps({"op": "stop"}) + "\n")
            self.proc.stdin.flush()
            self.proc.wait(timeout=60)
        assert self.proc.returncode == 0, f"pg_bridge.mts exited {self.proc.returncode}"

    def count(self, world: str, table: str) -> int:
        n: int = self.call("count", world=world, table=table)
        return n


class BridgeWriter:
    def __init__(self, bridge: Bridge, world: str) -> None:
        self._b, self._w = bridge, world

    def _write(self, what: str, body: Any) -> InternalBatchResponse:
        return InternalBatchResponse.model_validate(self._b.call("write", world=self._w, what=what, body=body))

    async def write_entities(self, req: InternalEntitiesBatchRequest) -> InternalBatchResponse:
        return self._write("entities", req.model_dump(mode="json", by_alias=True))

    async def write_edges(self, req: InternalEdgesBatchRequest) -> InternalBatchResponse:
        return self._write("edges", req.model_dump(mode="json", by_alias=True))

    def write_claims(self, claims: list[dict[str, Any]]) -> InternalBatchResponse:
        return self._write("claims", {"claims": claims})


class _Transport(httpx.AsyncBaseTransport):
    """core-api's app, in-process inside the bridge; the bridge adds the world's run token and the service secret."""

    def __init__(self, bridge: Bridge, world: str) -> None:
        self._b, self._w = bridge, world

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = (await request.aread()).decode() or None
        out = self._b.call(
            "http",
            world=self._w,
            method=request.method,
            path=request.url.raw_path.decode(),
            headers={"content-type": "application/json"},
            body=body,
        )
        return httpx.Response(out["status"], content=out["body"].encode(), headers={"content-type": "application/json"})


#: A context for the client; core reads the tenant from the bridge's token, never from here.
CTX = RunContext(
    "01920000-0000-7000-8000-0000000058a1", "01920000-0000-7000-8000-0000000058a2", ("*",), "ask", "member:test", 2_000_000_000, "t"
)


class BridgeReader:
    """role "svc": InternalClient.graph_query through core's real route. role "admin": core's statement as superuser."""

    def __init__(self, bridge: Bridge, world: str, role: str = "svc") -> None:
        self._b, self._w, self._role = bridge, world, role
        self._client = InternalClient(
            CTX, base_url="http://core.test", service_secret="bridge-adds-it", transport=_Transport(bridge, world)
        )

    async def graph_query(self, template: str, args: dict[str, str | int]) -> list[Row]:
        if self._role == "svc":
            return await self._client.graph_query(template, args)
        rows: list[Row] = self._b.call("admin_graph", world=self._w, template=template, args=dict(args))
        return rows
