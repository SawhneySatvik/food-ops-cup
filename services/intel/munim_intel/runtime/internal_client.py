"""Client for core-api's `/internal/intel/v1` (R25): intel's only write path — intel never writes Postgres.

Every call carries the run token (`authorization: Bearer`) and the service secret; core-api takes tenant and
outlet scope from the token alone, so no body here has a tenant. Bodies and responses are the generated
contract models (packages/contracts/src/internal). Every internal route is a POST that can create a row, so
none is retried; only the model-role read is (it is an idempotent GET). An error exposes the status, core's
error `code` and `reason_code` — never the response body.
"""

from __future__ import annotations

from typing import TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from munim_intel.contracts_gen.models import (
    Error,
    InternalAliasesBatchRequest,
    InternalAnswersRequest,
    InternalAnswersResponse,
    InternalBatchResponse,
    InternalBriefItemsResponse,
    InternalChunksBatchRequest,
    InternalClaimsBatchRequest,
    InternalDraftsRequest,
    InternalDraftsResponse,
    InternalEdgesBatchRequest,
    InternalEmbeddingsBatchRequest,
    InternalEntitiesBatchRequest,
    InternalEventsClaimRequest,
    InternalEventsClaimResponse,
    InternalFindingsRequest,
    InternalFindingsResponse,
    InternalGraphQueryRequest,
    InternalGraphQueryResponse,
    InternalQuotesBatchRequest,
    InternalSnapshotsRequest,
    InternalSpendRequest,
    InternalTracesBatchRequest,
    InternalTracesBatchResponse,
    InternalWatchClaimRequest,
    InternalWatchClaimResponse,
    InternalWikiBatchRequest,
    InternalWikiBatchResponse,
    PlatformModelRoles,
    Snapshot,
)
from munim_intel.runtime.context import RunContext

PREFIX = "/internal/intel/v1"
SERVICE_SECRET_HEADER = "x-munim-service-secret"
# Not in packages/contracts yet: requested from T-040 (b-40) — munim_svc already holds SELECT on platform.model_role.
MODEL_ROLES_PATH = f"{PREFIX}/model-roles"

R = TypeVar("R", bound=BaseModel)


class CoreError(Exception):
    def __init__(self, status: int, code: str, reason_code: str | None) -> None:
        super().__init__(f"core-api {status} {code}" + (f" ({reason_code})" if reason_code else ""))
        self.status = status
        self.code = code
        self.reason_code = reason_code


class InternalClient:
    def __init__(
        self,
        ctx: RunContext,
        *,
        base_url: str,
        service_secret: str,
        timeout_s: float = 10.0,
        read_attempts: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._ctx = ctx
        self._read_attempts = read_attempts
        self._http = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout_s,
            transport=transport,
            headers={"authorization": f"Bearer {ctx.token}", SERVICE_SECRET_HEADER: service_secret},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    @staticmethod
    def _error(res: httpx.Response) -> CoreError:
        try:
            body = Error.model_validate_json(res.content).error
            return CoreError(res.status_code, body.code, body.reason_code.root if body.reason_code else None)
        except ValidationError:
            return CoreError(res.status_code, "unparseable", None)

    async def _post(self, path: str, body: BaseModel, out: type[R]) -> R:
        res = await self._http.post(f"{PREFIX}/{path}", json=body.model_dump(mode="json", by_alias=True))
        if not res.is_success:
            raise self._error(res)
        return out.model_validate_json(res.content)

    async def claim_event(self, event_id: str) -> InternalEventsClaimResponse | None:
        """None when the event was already claimed (409): ack and stop, no model re-spend."""
        try:
            return await self._post(
                "events:claim", InternalEventsClaimRequest.model_validate({"event_id": event_id}), InternalEventsClaimResponse
            )
        except CoreError as e:
            if e.status == 409:
                return None
            raise

    async def claim_watch(self, pack: str) -> InternalWatchClaimResponse:
        return await self._post("watch:claim", InternalWatchClaimRequest(pack=pack), InternalWatchClaimResponse)

    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot:
        return await self._post("snapshots", req, Snapshot)

    async def write_finding(self, req: InternalFindingsRequest) -> InternalFindingsResponse:
        return await self._post("findings", req, InternalFindingsResponse)

    async def write_draft(self, req: InternalDraftsRequest) -> InternalDraftsResponse:
        return await self._post("drafts", req, InternalDraftsResponse)

    async def write_answer(self, req: InternalAnswersRequest) -> InternalAnswersResponse:
        return await self._post("answers", req, InternalAnswersResponse)

    async def write_traces(self, req: InternalTracesBatchRequest) -> InternalTracesBatchResponse:
        return await self._post("traces:batch", req, InternalTracesBatchResponse)

    # T-040b batch writes (idempotent by id; same id + another body → 409). Ingestion, the graph projector and the
    # negotiation write only through these.
    async def write_entities(self, req: InternalEntitiesBatchRequest) -> InternalBatchResponse:
        return await self._post("entities:batch", req, InternalBatchResponse)

    async def write_edges(self, req: InternalEdgesBatchRequest) -> InternalBatchResponse:
        return await self._post("edges:batch", req, InternalBatchResponse)

    async def write_aliases(self, req: InternalAliasesBatchRequest) -> InternalBatchResponse:
        return await self._post("aliases:batch", req, InternalBatchResponse)

    async def write_chunks(self, req: InternalChunksBatchRequest) -> InternalBatchResponse:
        return await self._post("chunks:batch", req, InternalBatchResponse)

    async def write_claims(self, req: InternalClaimsBatchRequest) -> InternalBatchResponse:
        return await self._post("claims:batch", req, InternalBatchResponse)

    async def write_embeddings(self, req: InternalEmbeddingsBatchRequest) -> InternalBatchResponse:
        return await self._post("embeddings:batch", req, InternalBatchResponse)

    async def write_quotes(self, req: InternalQuotesBatchRequest) -> InternalBatchResponse:
        return await self._post("quotes:batch", req, InternalBatchResponse)

    async def write_wiki(self, req: InternalWikiBatchRequest) -> InternalWikiBatchResponse:
        return await self._post("wiki:batch", req, InternalWikiBatchResponse)

    async def write_spend(self, req: InternalSpendRequest) -> InternalBatchResponse:
        """Model spend, one row per provider call (trace/spend.py). core stamps `at` and always records it, past the cap
        too; the currency must be the month's budget currency."""
        return await self._post("spend", req, InternalBatchResponse)

    async def graph_query(self, template: str, args: dict[str, str | int]) -> list[dict[str, str | int | None]]:
        """One core-owned graph template under the run's tenant (core binds it from the token; never an argument).
        A POST, but it writes nothing; not retried all the same, like every internal POST."""
        req = InternalGraphQueryRequest.model_validate({"template": template, "args": args})
        res = await self._post("graph:query", req, InternalGraphQueryResponse)
        rows: list[dict[str, str | int | None]] = res.model_dump(mode="json")["rows"]
        return rows

    async def _get(self, path: str, out: type[R]) -> R:
        """Retried on a network error, 429 or 5xx — a GET writes nothing."""
        last: Exception | None = None
        for _ in range(self._read_attempts):
            try:
                res = await self._http.get(path)
            except httpx.TransportError as e:
                last = e
                continue
            if res.is_success:
                return out.model_validate_json(res.content)
            last = self._error(res)
            if res.status_code != 429 and res.status_code < 500:
                break
        assert last is not None
        if isinstance(last, CoreError):
            raise last
        raise CoreError(0, f"network:{type(last).__name__}", None)

    async def model_roles(self) -> PlatformModelRoles:
        """platform.model_role (R36)."""
        return await self._get(MODEL_ROLES_PATH, PlatformModelRoles)

    async def brief_items(self) -> InternalBriefItemsResponse:
        """core's ranked inbox for this brief run (impact x confidence x urgency, deduped, drafts attached). Core refuses
        any other trigger. No dedupe key rides in it."""
        return await self._get(f"{PREFIX}/brief-items", InternalBriefItemsResponse)
