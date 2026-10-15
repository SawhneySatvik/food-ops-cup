// A person asks the simulated suppliers for quotes (T-114; pack inventory-purchasing §6 "Trigger: … or a person's ask").
//   POST /v1/rfq-requests  purchasing.rfq.request.v1 {rfq_id, ingredient_id, outlet_ids}
//   1. executeCommand: the person's own command, judged per chosen outlet by core.command_authority (0032's row: owner,
//      manager, judge, outlet scope, no book table; without it the authority read finds nothing and the command_log FK
//      refuses the type too); one audit entry under their name. An RFQ to simulated suppliers is not books (R22):
//      nothing else is written here.
//   2. Only on the first execution (a replay returns the stored bytes and never starts a second run): core reads the
//      ingredient, the tenant's simulated suppliers with an agent card and the active items under the person's own
//      context, mints an `ask` run (actor = the person, scope = exactly the chosen outlets; intel.run has no negotiation
//      trigger, and `ask` is the member-started kind) and calls intel's `/negotiate` synchronously. intel writes only
//      through /internal/intel/v1 (forecast, quotes, snapshots, the PO draft); the PO is a draft a person approves (R16).
// The response body is the stored command result. The run's outcome rides in two response headers on the first
// execution only (`X-Munim-Negotiation`: a status code; `X-Munim-Draft-Id`), never in the body, so a replay stays
// byte-identical. An intel failure after the commit is 503: the request is on record, no draft exists, and the person
// asks again (a new key).
import { PACKS } from "@munim/contracts/packs";
import { IntelNegotiateResponse, PurchasingRfqRequestV1 } from "@munim/contracts/purchasing";
import { evaluateAuthority } from "@munim/core-domain/authority";
import { contextOf, type Principal } from "../../auth/resolve.ts";
import type { CommandHandler } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Deps } from "../../lib/types.ts";
import { endRun, mintRunTokenIn, type OutletScope, type Queryable, type RunTokenKeys } from "../../runtoken/index.ts";

export const RFQ_COMMAND = "purchasing.rfq.request.v1";
export const NEGOTIATION_HEADER = "X-Munim-Negotiation";
export const DRAFT_ID_HEADER = "X-Munim-Draft-Id";
export const SERVICE_SECRET_HEADER = "x-munim-service-secret";
/** Three simulated suppliers, two counter rounds and their recorded or live model calls (12 at most, run.py). */
export const NEGOTIATE_TIMEOUT_MS = 120_000;

export interface NegotiateBody {
  rfq_id: string; ingredient_id: string; item_name: string; unit: string; currency: string; minor_unit: number;
  outlet_ids: string[]; suppliers: Array<{ supplier_id: string; kind: "simulated"; card_url: string }>; item_ids: string[];
}
/** core → intel `/negotiate` with the run token; resolves to intel's JSON body (validated here). */
export type NegotiatePort = (runToken: string, body: NegotiateBody) => Promise<unknown>;
export interface RfqConfig { keys: RunTokenKeys; intel: NegotiatePort }

const configs = new WeakMap<Deps, RfqConfig>();
/** Wires the negotiation call into one composed app, keyed by that Deps object (as configureThreads). */
export function configureRfq(deps: Deps, cfg: RfqConfig): void {
  configs.set(deps, cfg);
}
export const rfqConfig = (deps: Deps) => configs.get(deps);

export const rfqRequest: CommandHandler = {
  type: RFQ_COMMAND,
  async run(c, command) {
    const p = PurchasingRfqRequestV1.parse(command.payload);
    const s = (await c.query<{ role: string | null; outlets: string | null }>(
      `SELECT nullif(current_setting('app.role', true), '') AS role, nullif(current_setting('app.outlet_ids', true), '') AS outlets`)).rows[0]!;
    const scope = s.outlets ? s.outlets.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : [];
    const rows = (await c.query<{ command_type: string; allowed_roles: string[]; scope: string; max_amount_minor: string | null }>(
      `SELECT command_type, allowed_roles, scope, max_amount_minor FROM core.command_authority WHERE command_type = $1`, [RFQ_COMMAND])).rows
      .map((r) => ({ ...r, max_amount_minor: null }));
    // Every chosen outlet is judged (as approvals judges every target outlet of a draft), never just the first.
    if (!p.outlet_ids.every((o) => evaluateAuthority({ command_type: RFQ_COMMAND, role: s.role ?? "", outlet_scope: scope, target_outlet_id: o }, rows).allow)) {
      throw new ApiError("forbidden", "authority_denied");
    }
    const outlets = await c.query(`SELECT 1 FROM core.outlet WHERE id = ANY ($1::uuid[])`, [p.outlet_ids]);
    const ing = await c.query(`SELECT 1 FROM core.ingredient WHERE id = $1 AND active`, [p.ingredient_id]);
    if (outlets.rowCount !== p.outlet_ids.length || ing.rowCount !== 1) throw new ApiError("bad_request");
    return { entityId: p.rfq_id, audit: [{ entity: "core.ingredient", entityId: p.ingredient_id, after: { rfq_id: p.rfq_id, outlet_ids: p.outlet_ids } }] };
  },
};

/** What core sends intel: its own reads under the person's context (RLS), never anything from the request but ids. */
async function negotiateBody(c: Queryable, p: { rfq_id: string; ingredient_id: string; outlet_ids: string[] }): Promise<NegotiateBody> {
  const t = (await c.query<{ country_code: "IN" | "AU"; base_currency: string }>(
    `SELECT country_code, base_currency FROM core.tenant WHERE tenant_id = current_setting('app.tenant_id')::uuid`)).rows[0]!;
  const ing = (await c.query<{ name: string; base_unit: string }>(`SELECT name, base_unit FROM core.ingredient WHERE id = $1`, [p.ingredient_id])).rows[0]!;
  const suppliers = (await c.query<{ supplier_id: string; card_url: string }>(
    `SELECT id AS supplier_id, a2a_card_url AS card_url FROM core.supplier WHERE kind = 'simulated' AND active AND a2a_card_url IS NOT NULL ORDER BY id LIMIT 10`)).rows;
  const items = (await c.query<{ id: string }>(`SELECT id FROM core.item WHERE active ORDER BY id LIMIT 200`)).rows;
  return {
    rfq_id: p.rfq_id, ingredient_id: p.ingredient_id, item_name: ing.name, unit: ing.base_unit, currency: t.base_currency,
    minor_unit: PACKS[t.country_code].currency.minor_unit, outlet_ids: p.outlet_ids,
    suppliers: suppliers.map((s) => ({ supplier_id: s.supplier_id, kind: "simulated" as const, card_url: s.card_url })), item_ids: items.map((i) => i.id),
  };
}

/** Step 2: the run. Returns the outcome headers; throws `unavailable` when intel fails (nothing is retried: a run spends
 *  model calls). */
export async function startNegotiation(
  deps: Deps, cfg: RfqConfig, m: Extract<Principal, { kind: "member" }>, payload: unknown,
): Promise<Record<string, string>> {
  const p = PurchasingRfqRequestV1.parse(payload);
  const body = await withContext(deps.pools.core, contextOf(m), (c) => negotiateBody(c, p));
  const scope = p.outlet_ids as OutletScope;
  const svc = <T>(s: { tenantId: string; outletScope: OutletScope }, fn: (q: Queryable) => Promise<T>) =>
    withContext(deps.pools.svc, { tenant_id: s.tenantId, outlet_ids: s.outletScope[0] === "*" ? "*" : s.outletScope, role: "service" }, fn);
  const { token, claims } = await svc({ tenantId: m.tenant_id, outletScope: scope }, (q) =>
    mintRunTokenIn(q, cfg.keys, { tenantId: m.tenant_id, outletScope: scope, trigger: "ask", actor: m.member_id }));
  try {
    const out = IntelNegotiateResponse.safeParse(await cfg.intel(token, body));
    if (!out.success || out.data.run_id !== claims.run_id) throw new ApiError("unavailable");
    deps.log(`POST /v1/rfq-requests: run ${claims.run_id} ${out.data.status}`);
    return { [NEGOTIATION_HEADER]: out.data.status, ...(out.data.draft_id ? { [DRAFT_ID_HEADER]: out.data.draft_id } : {}) };
  } catch (e) {
    if (!(e instanceof ApiError)) deps.log("POST /v1/rfq-requests: intel call failed", e);
    throw new ApiError("unavailable");
  } finally {
    await endRun({ svc }, m.tenant_id, claims.run_id);
  }
}

export interface HttpNegotiatePortOptions {
  /** intel's base URL, e.g. http://127.0.0.1:8081 */
  url: string;
  serviceSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** The HTTP NegotiatePort: core → intel `POST /negotiate` with the run token as the bearer and the service secret.
 *  Errors carry the status or the error's name only, never a body or the token. */
export function createHttpNegotiatePort(o: HttpNegotiatePortOptions): NegotiatePort {
  const endpoint = new URL("negotiate", o.url.endsWith("/") ? o.url : `${o.url}/`).toString();
  const doFetch = o.fetch ?? fetch;
  return async (runToken, body) => {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${runToken}`, [SERVICE_SECRET_HEADER]: o.serviceSecret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? NEGOTIATE_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`intel /negotiate: ${(e as Error).name}`);
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new Error(`intel /negotiate: HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new Error(`intel /negotiate: ${(e as Error).name}`);
    }
  };
}
