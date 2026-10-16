// executeCommand (03-architecture §1.6): one munim_core transaction does the idempotency check, sets
// app.command_type, runs the handler, appends audit entries and outbox rows, and stores the result; after
// commit the transaction's outbox rows are published. Publishing never fails the request.
import { REPLAYED_HEADER, type CommandEnvelope, type CommandResult } from "@munim/contracts";
import { refuseOnDemo } from "../lib/demo-guard.ts";
import type { Queryable } from "../runtoken/index.ts";
import { canonicalJson, sha256Hex, uuidv7 } from "./canonical.ts";
import { parseStoredEvent, publishCommitted, type OutboxRow, type PublishDeps } from "./outbox.ts";

/** One transaction on the munim_core pool with the request's SET LOCAL app.* identity context already
 *  applied (T-004's withContext): BEGIN; set_config…; fn; COMMIT, or ROLLBACK and rethrow. It may also be an
 *  OUTER transaction the caller commits later (approvals): then omit `publish` and pass
 *  ExecuteResult.outbox to publishCommitted() after that commit. */
export type CoreTx = <T>(fn: (c: Queryable) => Promise<T>) => Promise<T>;

/** The verified principal (never taken from the request body). Stored on command_log and every audit entry. */
export interface Actor {
  kind: "member" | "customer" | "operator";
  id: string;
  role: string;
}

export interface CommandContext {
  tx: CoreTx;
  tenantId: string;
  actor: Actor;
  /** Set when an approved draft executes (audit_log.decision_id). */
  decisionId?: string;
  /** Publish right after `tx` returns. Only when `tx` commits on return — never with an outer transaction
   *  (that would publish uncommitted rows); omitted, the caller publishes ExecuteResult.outbox itself. */
  publish?: PublishDeps;
  /** Told the ids of events left for the sweeper. Ids only — never payloads or tokens. */
  onPublishDeferred?: (eventIds: string[], error: unknown) => void;
}

export interface AuditEntry {
  /** Defaults to the command type. */
  action?: string;
  /** Schema-qualified table, e.g. "core.channel". */
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** An event to write to core.outbox; the envelope (id, time, source, tenantid) is filled in here. */
export interface EventDraft {
  /** munim.<module>.<entity>.<past-tense-verb>.v<N> */
  type: string;
  /** The entity id (CloudEvent subject, outbox aggregateid). */
  subject: string;
  /** Debezium aggregatetype, e.g. "order". */
  aggregateType: string;
  /** Ids and categorical fields only — never amounts (shared/cloudevents.ts). */
  data: Record<string, unknown>;
}

export interface HandlerOutput {
  entityId: string;
  /** At least one: a command that changes nothing auditable is not a command. */
  audit: AuditEntry[];
  events?: EventDraft[];
}

/** A handler is bound to exactly one command type. The book guard admits a write when the role may run
 *  app.command_type on that table (0007 target_tables, MB008), but types that share a table differ in who
 *  may run them (orders.shift.open.v1 staff, orders.shift.close.v1 manager+) — so the type set for the
 *  guard must be the handler's own, never just whatever the request body names. */
export interface CommandHandler {
  type: string;
  run(c: Queryable, command: CommandEnvelope): Promise<HandlerOutput>;
}

export interface ExecuteResult {
  /** The response body: the stored result's exact text, identical on every replay. */
  body: string;
  /** True when `body` is the stored result of an earlier identical request (send replayHeaders()). */
  replayed: boolean;
  /** The outbox rows this execution wrote (empty on replay), for a caller publishing after an outer commit. */
  outbox: OutboxRow[];
}

/** Response headers for a command result: `X-Munim-Replayed: true` on a replay, nothing otherwise. Replay is
 *  signalled only here — the body is the stored bytes, identical to the first response. */
export function replayHeaders(r: Pick<ExecuteResult, "replayed">): Record<string, string> {
  return r.replayed ? { [REPLAYED_HEADER]: "true" } : {};
}

export class IdempotencyConflict extends Error {
  readonly status = 409;
  readonly code = "idempotency_conflict";
  constructor() {
    super("idempotency key already used for a different request");
  }
}

export class CommandTypeMismatch extends Error {
  readonly status = 422;
  readonly code = "command_type_mismatch";
  constructor() {
    super("command type does not match the route's handler");
  }
}

/** The request hash covers everything that defines the command, including who sent it. */
export function requestHash(actor: Actor, command: CommandEnvelope): string {
  return sha256Hex(canonicalJson({
    actor: { kind: actor.kind, id: actor.id },
    command_id: command.command_id,
    type: command.type,
    payload: command.payload,
  }));
}

/** command_log and audit attribution come from ctx, the book guard reads the SET LOCAL context: they must be
 *  the same identity, or the audit trail could name someone other than the person the guard admitted. */
async function assertIdentity(c: Queryable, ctx: CommandContext): Promise<void> {
  const principal = { member: "app.member_id", customer: "app.customer_id", operator: "app.operator_id" }[ctx.actor.kind];
  const r = await c.query<{ tenant: string | null; role: string | null; principal: string | null; decision: string | null }>(
    `SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant, nullif(current_setting('app.role', true), '') AS role,
            nullif(current_setting($1, true), '') AS principal, nullif(current_setting('app.decision_id', true), '') AS decision`,
    [principal]);
  const s = r.rows[0]!;
  if (s.tenant !== ctx.tenantId || s.role !== ctx.actor.role || s.principal !== ctx.actor.id || s.decision !== (ctx.decisionId ?? null)) {
    throw new Error("executeCommand: ctx does not match the transaction's SET LOCAL identity");
  }
}

/** 0014 (F4): a customer can neither read nor write command_log, audit_log or outbox (RESTRICTIVE
 *  customer_scope). Around the bookkeeping the customer role is cleared (same transaction, same tenant) and
 *  restored for the handler, whose book writes the guard must still judge as the customer's own. While it is
 *  cleared the guard admits no book write at all (no role → MB001). Members need no switch. */
async function setShopperRole(c: Queryable, ctx: CommandContext, on: boolean): Promise<void> {
  if (ctx.actor.kind !== "customer") return;
  await c.query(`SELECT set_config('app.role', $1, true)`, [on ? ctx.actor.role : ""]);
}

export async function executeCommand(ctx: CommandContext, command: CommandEnvelope, handler: CommandHandler): Promise<ExecuteResult> {
  if (command.type !== handler.type) throw new CommandTypeMismatch();
  const hash = requestHash(ctx.actor, command);
  const done = await ctx.tx(async (c) => {
    await assertIdentity(c, ctx);
    await setShopperRole(c, ctx, false);
    // Serialise concurrent requests with one key, so the loser replays instead of hitting 23505.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('core.command_log:' || $1 || ':' || $2, 0))`,
      [ctx.tenantId, command.idempotency_key]);
    const prior = await c.query<{ request_hash: string; body: string }>(
      `SELECT request_hash, result::text AS body FROM core.command_log WHERE tenant_id = $1 AND idempotency_key = $2`,
      [ctx.tenantId, command.idempotency_key]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) throw new IdempotencyConflict();
      return { body: prior.rows[0].body, replayed: true, rows: [] as OutboxRow[] };
    }

    // R64 X-2: after the replay lookup (a stored result still replays), before anything is written.
    await refuseOnDemo(c, command.type);
    await c.query(`SELECT set_config('app.command_type', $1, true)`, [command.type]);
    await setShopperRole(c, ctx, true);
    const out = await handler.run(c, command);
    await setShopperRole(c, ctx, false);
    if (out.audit.length === 0) throw new Error(`executeCommand: ${command.type} produced no audit entry`);

    for (const a of out.audit) {
      await c.query(
        `INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, before, after, decision_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ctx.tenantId, ctx.actor, a.action ?? command.type, a.entity, a.entityId,
         a.before === undefined ? null : JSON.stringify(a.before),
         a.after === undefined ? null : JSON.stringify(a.after), ctx.decisionId ?? null]);
    }

    const rows: OutboxRow[] = [];
    for (const e of out.events ?? []) {
      const id = uuidv7();
      const payload = parseStoredEvent({
        specversion: "1.0",
        id,
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        tenantid: ctx.tenantId,
        source: `/tenants/${ctx.tenantId}/${e.type.split(".")[1]}`,
        type: e.type,
        subject: e.subject,
        data: e.data,
      });
      await c.query(
        `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
        [ctx.tenantId, id, e.aggregateType, e.subject, e.type, payload]);
      rows.push({ tenant_id: ctx.tenantId, id, payload });
    }

    const now = await c.query<{ at: Date }>(`SELECT now() AS at`);
    const result: CommandResult = {
      command_id: command.command_id,
      type: command.type,
      entity_id: out.entityId,
      committed_at: now.rows[0]!.at.toISOString(),
    };
    // Served from Postgres's own jsonb text so the first response and every replay are byte-identical.
    const stored = await c.query<{ body: string }>(
      `INSERT INTO core.command_log (tenant_id, idempotency_key, command_id, command_type, actor, request_hash, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING result::text AS body`,
      [ctx.tenantId, command.idempotency_key, command.command_id, command.type, ctx.actor, hash, result]);
    return { body: stored.rows[0]!.body, replayed: false, rows };
  });

  if (ctx.publish) await publishCommitted(ctx.publish, ctx.tenantId, done.rows, ctx.onPublishDeferred);
  return { body: done.body, replayed: done.replayed, outbox: done.rows };
}
