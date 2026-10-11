"""pg_bridge.mts from Python: embedded Postgres + core-api's batch writers as a subprocess, spoken to in JSON lines.
The writer and reader here are the test stand-ins for InternalClient (writes) and core's graph read (SQL under the
run token's tenant); the SQL they run is the adapter's own `sql/<template>.sql`."""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from munim_intel.contracts_gen.models import InternalBatchResponse, InternalEdgesBatchRequest, InternalEntitiesBatchRequest
from munim_intel.graph import Row, template_sql

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


class BridgeReader:
    def __init__(self, bridge: Bridge, world: str, role: str = "svc") -> None:
        self._b, self._w, self._role = bridge, world, role

    async def read(self, name: str, params: Mapping[str, str | int]) -> list[Row]:
        rows: list[Row] = self._b.call("read", world=self._w, sql=template_sql(name), params=dict(params), **{"as": self._role})
        return rows
