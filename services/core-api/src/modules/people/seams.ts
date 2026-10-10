// Cross-module seams: finance.postFor and finance.reverseSource (T-026 owns them; brief "Cross-module seams"). Resolved lazily from
// `../finance/index.ts`. A missing module or export FAILS CLOSED with `unavailable` (R3-M2): a payroll is never
// approved without its entry. Gates may inject postFor with `setPostFor`. Signature fixed by the brief:
//   postFor(tx, rule_id, source_ref)   source_ref = 'core.<table>:<uuid>' (db/README "Context keys")
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

export type PostFor = (tx: Queryable, rule_id: string, source_ref: string) => Promise<unknown>;

let override: PostFor | undefined;
/** Test hook: replaces the seam for the process; returns the undo. */
export function setPostFor(fn: PostFor | undefined): () => void {
  const prev = override;
  override = fn;
  return () => {
    override = prev;
  };
}

let real: PostFor | null | undefined;
async function resolve(): Promise<PostFor> {
  if (override) return override;
  if (real === undefined) {
    const file = join(import.meta.dirname, "..", "finance", "index.ts");
    real = null;
    if (existsSync(file)) {
      const mod = (await import(pathToFileURL(file).href)) as { postFor?: PostFor };
      if (typeof mod.postFor === "function") real = mod.postFor;
    }
  }
  if (!real) throw new ApiError("unavailable");
  return real;
}

export async function postFor(tx: Queryable, rule_id: string, source_ref: string): Promise<void> {
  await (await resolve())(tx, rule_id, source_ref);
}

/** finance.reverseSource: the reversal of a voided payroll's entry (rule finance.reverse_payroll). No stand-in:
 *  without finance the void is refused (`unavailable`) rather than leaving the entry standing. */
export async function reverseSource(tx: Queryable, rule_id: "finance.reverse_payroll", source_ref: string): Promise<void> {
  const file = join(import.meta.dirname, "..", "finance", "index.ts");
  const mod = (await import(pathToFileURL(file).href)) as { reverseSource?: (tx: Queryable, r: string, s: string) => Promise<unknown> };
  if (typeof mod.reverseSource !== "function") throw new ApiError("unavailable");
  await mod.reverseSource(tx, rule_id, source_ref);
}
