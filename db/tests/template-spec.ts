// The independent source for the M-C template gates (BOARD W3.0 m-1 gate 1): template ids, output columns and params
// parsed from the pack docs' §3 tables and ADR-014 §7.3 — never from a migration or the database.
//   packs/<pack>.md §3: | `id` | purpose | params | output columns ← numeric source |
//   ADR-014 §7.3: `finance.margin_bridge`, params `period_month`, `compare_month`; one row per component (the bullet
//   list, plus the Σ row `margin_delta_minor`), each with `prior_minor`, `current_minor`, `delta_minor`, `share_bp`.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

export interface TemplateSpec {
  id: string;
  params: string[];
  columns: string[];
  source: string;
}

const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
/** Drop parenthesised remarks, nested ones included (a cell names columns outside them). */
function stripParens(s: string): string {
  let out = s;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/\([^()]*\)/g, "");
  }
  return out;
}

/** §3 table rows of one pack file. */
export function packTemplates(pack: string): TemplateSpec[] {
  const file = join(ROOT, "docs", "plan", "packs", `${pack}.md`);
  const text = readFileSync(file, "utf8");
  const start = text.indexOf("\n## 3 ");
  const end = text.indexOf("\n## ", start + 1);
  if (start < 0 || end < 0) throw new Error(`${file}: no §3 section`);
  const out: TemplateSpec[] = [];
  for (const line of text.slice(start, end).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // | `id` | purpose | params | columns | → ["", id, purpose, params, columns, ""]. The id cell may carry a remark after
    // the id (people.md: "`people.payroll_lines` (IN)" — a pack-scope note, not part of the id).
    if (cells.length !== 6 || !/^`[a-z_]+\.[a-z_]+`( \([^()]*\))?$/.test(cells[1]!)) continue;
    const id = ticks(cells[1]!)[0]!;
    // `name?` = optional (nullable) and `name[]` = an array param (compliance.md: `required_kinds[]`): the name is bare.
    const params = ticks(cells[3]!).map((p) => p.replace(/\?$/, "").replace(/\[\]$/, ""));
    const columns: string[] = [];
    for (const seg of stripParens(cells[4]!).split(";")) {
      const named = seg.includes("←") ? seg.slice(0, seg.indexOf("←")) : seg;
      for (const c of ticks(named)) if (/^[a-z_][a-z0-9_]*$/.test(c) && !columns.includes(c)) columns.push(c);
    }
    out.push({ id, params, columns, source: `${pack}.md §3` });
  }
  return out;
}

/** ADR-014 §7.3: the margin bridge. The label column is `component` (the ADR's "one per component"). */
export function bridgeSpec(): TemplateSpec & { components: string[]; sumRow: string } {
  const file = join(ROOT, "docs", "plan", "adr", "ADR-014-intelligence-layer.md");
  const text = readFileSync(file, "utf8");
  const start = text.indexOf("### 7.3 ");
  const end = text.indexOf("\n### ", start + 1);
  if (start < 0 || end < 0) throw new Error(`${file}: no §7.3`);
  const sec = text.slice(start, end);
  const id = ticks(sec.split("\n")[0]!)[0]!;
  const params = ticks(sec.split("\n").find((l) => l.startsWith("**Params:**"))!);
  const rowsLine = sec.split("\n").find((l) => l.startsWith("**Rows**"))!;
  const columns = ["component", ...ticks(rowsLine).map((c) => /^[a-z_]+/.exec(c)![0])];
  const components = sec.split("\n").filter((l) => /^- `[a-z_]+`/.test(l)).map((l) => ticks(l)[0]!);
  const sumLine = sec.split("\n").find((l) => l.startsWith("There is also a Σ row"))!;
  return { id, params, columns, source: "ADR-014 §7.3", components, sumRow: ticks(sumLine)[0]! };
}

/** The template version a pack §3 row describes, where it is not version 1: finance.md §3 carries the 0023 (M-C1e)
 *  version-2 columns and gst_check's `outlet_id?`. Hand-kept; other packs' §3 rows describe version 1 (their later
 *  versions' extra columns are hand lists in tests/mc1d.test.ts and tests/mc1e.test.ts). */
export const SPEC_VERSION: Record<string, number> = {
  "finance.settlement_vs_orders": 2, "finance.missing_payouts": 2, "finance.tender_vs_bank": 2, "finance.gst_check": 2,
};
export const specVersion = (id: string) => SPEC_VERSION[id] ?? 1;

/** Every M-C1a template: catalogue §3 + finance §3 + the bridge. */
export function mc1aTemplates(): TemplateSpec[] {
  return [...packTemplates("catalogue"), ...packTemplates("finance"), bridgeSpec()];
}

/** M-C1bc (0021): the remaining packs' §3 tables (BOARD W3 M-C1b + M-C1c). */
export const MC1BC_PACKS = ["kitchen", "inventory-purchasing", "forecast", "people", "customers-growth", "compliance-assets", "market-strategy"] as const;
/** inventory.below_reorder is in inventory-purchasing §3 but is the 0005 template (v1, not the pack's columns): M-C1bc
 *  adds the pack's other ids ("inventory_purchasing (10 new)", BOARD). Hand-kept, with its reason in 0021's header. */
export const MC1BC_NOT_NEW = ["inventory.below_reorder"];
export function mc1bcTemplates(): TemplateSpec[] {
  return MC1BC_PACKS.flatMap((p) => packTemplates(p));
}

// node db/tests/template-spec.ts → prints what it parsed (the gate's expected values, for a person to read).
if (import.meta.filename === process.argv[1]) {
  const all = mc1aTemplates();
  for (const t of all) console.log(`${t.id} (${t.source}) params=[${t.params.join(", ")}] columns=[${t.columns.join(", ")}]`);
  const b = bridgeSpec();
  console.log(`bridge components: ${b.components.join(", ")} + Σ ${b.sumRow}`);
  console.log(`${all.length} template ids (M-C1a)`);
  const bc = mc1bcTemplates();
  for (const t of bc) console.log(`${t.id} (${t.source}) params=[${t.params.join(", ")}] columns=[${t.columns.join(", ")}]`);
  console.log(`${bc.length} template ids (M-C1bc), ${bc.length - MC1BC_NOT_NEW.length} new`);
}
