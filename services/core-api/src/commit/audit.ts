// Audit-chain verifier. The chain is written by the core.audit_log_chain() trigger (0003):
//   hash = sha256_hex(utf8(join("\n", [prev_hash, tenant_id, seq, actor::text, action, entity, entity_id,
//          before::text|'null', after::text|'null', decision_id|'null', created_at UTC …US"Z"])))
// (db/README.md). Postgres renders every field as text, so jsonb is never re-serialised in JS; a row passes
// only if its seq is the next integer, its prev_hash is the previous row's hash, and its hash recomputes.
import type { SvcTx } from "../runtoken/index.ts";
import { sha256Hex } from "./canonical.ts";

export interface AuditVerdict {
  ok: boolean;
  /** The tenant's audit rows. */
  rows: number;
  /** The first seq whose position, link or hash is wrong; null when ok. */
  firstBadSeq: number | null;
}

const PAGE = 1000;

export async function verifyAuditChain(read: SvcTx, tenantId: string): Promise<AuditVerdict> {
  return read({ tenantId, outletScope: ["*"] }, async (c) => {
    let prev = "0".repeat(64);
    let expected = 1;
    let after = 0;
    let rows = 0;
    for (;;) {
      // ORDER BY a.seq, not seq: the output column `seq` is text, and ordering by it sorts 10 before 2.
      const page = await c.query<Record<string, string>>(
        `SELECT seq::text AS seq, tenant_id::text AS tenant, actor::text AS actor, action, entity, entity_id,
                coalesce(before::text, 'null') AS before, coalesce(after::text, 'null') AS after,
                coalesce(decision_id::text, 'null') AS decision,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, prev_hash, hash
           FROM core.audit_log a WHERE a.tenant_id = $1 AND a.seq > $2 ORDER BY a.seq LIMIT ${PAGE}`,
        [tenantId, after]);
      for (const r of page.rows) {
        rows++;
        const seq = Number(r.seq);
        const line = [r.prev_hash, r.tenant, r.seq, r.actor, r.action, r.entity, r.entity_id, r.before, r.after, r.decision, r.at].join("\n");
        if (seq !== expected || r.prev_hash !== prev || sha256Hex(line) !== r.hash) {
          const total = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.audit_log WHERE tenant_id = $1`, [tenantId]);
          return { ok: false, rows: total.rows[0]!.n, firstBadSeq: seq };
        }
        prev = r.hash!;
        expected++;
        after = seq;
      }
      if (page.rows.length < PAGE) return { ok: true, rows, firstBadSeq: null };
    }
  });
}
