// Outbox → Publisher (03-architecture §1.6, R35, project rule 16). The command transaction stores each
// event as a CloudEvent without its run token; at publish time a munim_svc transaction mints one event run
// per row (intel.run) and the token rides in the `munimrun` extension. Rows are marked published only after
// the Publisher reports delivery; anything else is left for the core-worker sweeper (at-least-once; intel
// dedupes on the CloudEvent id via events:claim).
import { CloudEvent, EVENT_TYPE_PATTERN } from "@munim/contracts";
import { SCHEMAS as EVENT_SCHEMAS } from "@munim/contracts/events";
import { mintRunTokenIn, type OutletScope, type Queryable, type RunTokenKeys, type SvcTx } from "../runtoken/index.ts";

/** The Publisher port (03-architecture §4). Resolves only when every event was delivered; throws otherwise. */
export interface Publisher {
  publish(events: readonly CloudEvent[]): Promise<void>;
}

/** A stored event: the CloudEvent minus `munimrun`, exactly as written to core.outbox.payload. */
export const StoredEvent = CloudEvent.omit({ munimrun: true });
export type StoredEvent = ReturnType<typeof StoredEvent.parse>;

/** Per-type stored-envelope schemas from the contracts' event registry (events/index.ts SCHEMAS). */
const STORED_BY_TYPE = new Map(Object.entries(EVENT_SCHEMAS)
  .filter(([type]) => EVENT_TYPE_PATTERN.test(type))
  .map(([type, schema]) => [type, (schema as unknown as typeof CloudEvent).omit({ munimrun: true })] as const));

/** Parses a stored envelope against its type's registered contract schema (review F7): an unregistered
 *  type, or `data` the type's schema does not allow (an amount, a quantity, an extra key), throws. */
export function parseStoredEvent(envelope: unknown): StoredEvent {
  const type = (envelope as { type?: unknown } | null)?.type;
  const schema = typeof type === "string" ? STORED_BY_TYPE.get(type) : undefined;
  if (!schema) throw new Error(`outbox: event type ${JSON.stringify(type)} has no registered contract schema`);
  StoredEvent.parse(envelope);
  return schema.parse(envelope) as StoredEvent;
}

/** The outbox columns publishing needs (a core.outbox_claim() row has these and more). */
export interface OutboxRow {
  tenant_id: string;
  id: string;
  payload: unknown;
}

export interface PublishDeps {
  publisher: Publisher;
  svc: SvcTx;
  keys: RunTokenKeys;
  now?: () => number;
}

/** Event runs carry no person: the sweeper can mint the identical run from the row alone (it does not know
 *  the command's actor), and findings are never attributed to whoever placed the order. INFERENCE —
 *  04-agent-framework §1 lists only watcher:<pack> | brief | member id. */
export const EVENT_RUN = { trigger: "event", actor: "watcher:events" } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Orchestrator ruling #18 (narrowest covering run scope): `data.outlet_id` → [that outlet]; a non-empty
 *  `data.outlet_ids` → exactly those outlets; neither → tenant-wide ['*']. Read from the stored row alone, so
 *  the request path and the sweeper mint the same scope. (A malformed id list falls to ['*'] here, but such a
 *  row fails its type schema in outboxRowToCloudEvent and is never delivered.) */
export function eventOutletScope(payload: unknown): OutletScope {
  const data = (payload as { data?: { outlet_id?: unknown; outlet_ids?: unknown } } | null)?.data;
  if (typeof data?.outlet_id === "string" && UUID.test(data.outlet_id)) return [data.outlet_id];
  const ids = data?.outlet_ids;
  if (Array.isArray(ids) && ids.length > 0 && ids.every((x) => typeof x === "string" && UUID.test(x))) return [...new Set(ids as string[])];
  return ["*"];
}

/** A stored row that can never become a valid event (unregistered type, data its schema refuses, an envelope
 *  that disagrees with its row). Shaped like core-worker's PoisonRowError (name, fixed `reason`, no row
 *  content in the message) so the sweeper can dead-letter it instead of treating it as intel being down. */
export class OutboxRowInvalid extends Error {
  readonly reason = "contract_invalid";
  constructor() {
    super("outbox row cannot be published: contract_invalid");
    this.name = "PoisonRowError";
  }
}

function validRow(row: OutboxRow): StoredEvent {
  let stored: StoredEvent;
  try {
    stored = parseStoredEvent(row.payload);
  } catch {
    throw new OutboxRowInvalid();
  }
  if (stored.id !== row.id || stored.tenantid !== row.tenant_id) throw new OutboxRowInvalid();
  return stored;
}

/** The one place a stored outbox row becomes a deliverable CloudEvent. Re-validates the stored envelope
 *  against its type's schema, so a malformed row never reaches intel (throws OutboxRowInvalid). */
export function outboxRowToCloudEvent(row: OutboxRow, runToken: string): CloudEvent {
  return { ...validRow(row), munimrun: runToken };
}

const tenantScope = (tenantId: string) => ({ tenantId, outletScope: ["*"] as OutletScope });

/** Mints one event run per row on `c` (a munim_svc transaction for `tenantId`) and encodes the events. */
async function encode(c: Queryable, deps: PublishDeps, tenantId: string, rows: readonly OutboxRow[]): Promise<CloudEvent[]> {
  // Validate every row before minting anything: a poison row must not leave intel.run rows behind.
  for (const row of rows) {
    if (row.tenant_id !== tenantId) throw new Error("outbox: row of another tenant in one batch");
    validRow(row);
  }
  const out: CloudEvent[] = [];
  for (const row of rows) {
    const { token } = await mintRunTokenIn(c, { ...deps.keys, ...(deps.now ? { now: deps.now } : {}) }, {
      tenantId, outletScope: eventOutletScope(row.payload), trigger: EVENT_RUN.trigger, actor: EVENT_RUN.actor,
    });
    out.push(outboxRowToCloudEvent(row, token));
  }
  return out;
}

/** Mint, publish, mark published_at. Returns the rows marked. Throws if delivery failed (rows stay
 *  unpublished; the minted runs simply expire). Call only after the rows' transaction has committed. */
export async function publishOutboxRows(deps: PublishDeps, tenantId: string, rows: readonly OutboxRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const events = await deps.svc(tenantScope(tenantId), (c) => encode(c, deps, tenantId, rows));
  await deps.publisher.publish(events);
  const r = await deps.svc(tenantScope(tenantId), (c) =>
    c.query(`UPDATE core.outbox SET published_at = now() WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND published_at IS NULL`,
      [tenantId, rows.map((x) => x.id)]));
  return r.rowCount ?? 0;
}

/** publishOutboxRows that never throws: a failure leaves the rows for the sweeper and reports their ids
 *  (ids only — never payloads or tokens). executeCommand calls it after its own commit; a caller that runs
 *  executeCommand inside an OUTER transaction (approvals) calls it with ExecuteResult.outbox after that
 *  outer transaction commits. */
export async function publishCommitted(
  deps: PublishDeps, tenantId: string, rows: readonly OutboxRow[], onDeferred?: (eventIds: string[], error: unknown) => void,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await publishOutboxRows(deps, tenantId, rows);
  } catch (err) {
    const ids = rows.map((r) => r.id);
    if (onDeferred) onDeferred(ids, err);
    else console.warn(`outbox: ${ids.length} event(s) left for the sweeper: ${ids.join(",")}`);
  }
}

/** Sweeper path (core-worker's per-row Publisher port): mint + encode + deliver one claimed row. The worker
 *  marks published_at itself after this resolves. Same event-run shape as the request path. A row that fails
 *  its contract rejects with OutboxRowInvalid before any run is minted or anything is sent. */
export function createRowPublisher(deps: PublishDeps) {
  return {
    async publish(row: OutboxRow): Promise<void> {
      const events = await deps.svc(tenantScope(row.tenant_id), (c) => encode(c, deps, row.tenant_id, [row]));
      await deps.publisher.publish(events);
    },
  };
}
