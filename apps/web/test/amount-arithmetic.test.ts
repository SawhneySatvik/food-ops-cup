// Cross-surface guarantee gate (rule 9, R40 C1; One Guarantee clause 2): no screen computes an amount. Values in
// *_minor / *_milli / *_bp fields are rendered by the format module or passed through, never added, subtracted,
// multiplied, divided or rounded in apps/web. Scans every source file under app/** and lib/** (tests excluded),
// INCLUDING template-literal expressions, through Number()/BigInt()/parseInt() wrappers, `.value` cells, destructured
// or assigned aliases, and Math.floor/round/ceil/trunc. Comparisons (`> 0`, `===`) are not arithmetic.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const UNIT = "(?:minor|milli|bp)";
const AMOUNT_FIELD = new RegExp(`\\b\\w*_${UNIT}\\b`);

/** Explicit exceptions: file + the exact code it may contain, each with its reason. Empty today: typed amounts are
 *  parsed to minor / milli units by packages/ui/format (parseMinor), which this scan does not cover by design. A lane
 *  that must parse input here adds one entry with its reason; nothing else belongs in it. */
const ALLOW: Array<{ file: string; code: RegExp; why: string }> = [];

/** Removes comments and the CONTENTS of '…' and "…" strings (not template literals: their ${} parts are code). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
}

/** Lines that do arithmetic on an amount: [line number, line]. Exported shape for the red-proof cases below. */
export function amountArithmetic(src: string): Array<[number, string]> {
  const c = code(src);
  // Aliases: `const { total_minor: t } = …`, `const t = o.total_minor`, `const t = Number(o.total_minor)`.
  const aliases = new Set<string>();
  for (const m of c.matchAll(new RegExp(`\\b\\w+_${UNIT}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*(?:[,}]|=(?!=))`, "g"))) aliases.add(m[1]!);
  for (const m of c.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:Number|BigInt|parseInt|parseFloat)?\\(?\\s*[\\w$.?]*_${UNIT}\\b(?:\\.value)?\\s*\\)?\\s*[;,\\n]`, "g"))) aliases.add(m[1]!);
  const alias = aliases.size ? `|\\b(?:${[...aliases].map((a) => a.replace(/\$/g, "\\$")).join("|")})\\b` : "";
  // An amount operand: a field (optionally .value), an alias, or either wrapped in Number()/BigInt()/parseInt().
  const field = `(?:[\\w$.?]*_${UNIT}\\b(?:\\.value)?${alias})`;
  const operand = `(?:(?:Number|BigInt|parseInt|parseFloat)\\(\\s*${field}[^()]*\\)|${field})`;
  const op = "(?:[-+*/%](?![-+=>/*])|\\*\\*)";
  const after = new RegExp(`${operand}\\s*${op}\\s*[\\w$(.\\[]`);
  const before = new RegExp(`[\\w$)\\].]\\s*${op}\\s*${operand}`);
  const compound = new RegExp(`${field}\\s*[-+*/%]=`);
  const rounding = new RegExp(`Math\\.(?:floor|round|ceil|trunc)\\([^;]*?_${UNIT}\\b`);
  const lines = c.split("\n");
  const hits: Array<[number, string]> = [];
  lines.forEach((l, i) => {
    if (after.test(l) || before.test(l) || compound.test(l) || rounding.test(l)) hits.push([i + 1, src.split("\n")[i]!.trim()]);
  });
  return hits;
}

test.each([
  ["template literal subtraction", "const s = `${o.total_minor - o.paid_minor}`;"],
  ["Number() wrapper", "const due = Number(t.total_minor) - p;"],
  ["Math.floor on a .value cell", "count: Math.floor(x.meals_portions_milli.value / 1000)"],
  ["destructured alias", "const { total_minor: total, paid_minor: paid } = o;\nconst left = total - paid;"],
  ["assigned alias", "const t = order.total_minor;\nshow(t * 2);"],
  ["compound assignment", "sum_minor += line.price_minor;"],
  ["basis points", "const pct = r.waste_bp / 100;"],
  ["multiplication by a quantity", "const line = qty * item.price_minor;"],
])("the scanner flags %s", (_, src) => {
  expect(amountArithmetic(src)).not.toEqual([]);
});

test.each([
  ["passing through", "body: { amount_minor: parsed, currency }"],
  ["formatting", "fmt.money(o.total_minor)"],
  ["comparison", "if (o.total_minor > 0 && o.paid_minor === o.total_minor) ok();"],
  ["prose and comments", '// total_minor - paid_minor is core\'s job\nconst s = "a_minor - b";'],
  ["an arrow function", "items.map((x) => x.price_minor)"],
  ["an object key set from a comparison", "const body = { unit_price_minor: kind === \"offer\" ? minor : null, data: a - b };"],
])("the scanner leaves %s alone", (_, src) => {
  expect(amountArithmetic(src)).toEqual([]);
});

function sources(): Array<{ file: string; src: string }> {
  const root = join(import.meta.dirname, "..");
  const out: Array<{ file: string; src: string }> = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push({ file: relative(root, p), src: readFileSync(p, "utf8") });
    }
  };
  walk(join(root, "app"));
  walk(join(root, "lib"));
  return out;
}

test("no apps/web source does arithmetic on an amount", () => {
  const files = sources();
  // Positive expected quantities, so an empty or mis-rooted scan cannot pass.
  expect(files.length).toBeGreaterThanOrEqual(40);
  expect(files.filter((f) => AMOUNT_FIELD.test(f.src)).length).toBeGreaterThanOrEqual(5);
  const hits = files.flatMap((f) =>
    amountArithmetic(f.src)
      .filter(([, line]) => !ALLOW.some((a) => a.file === f.file && a.code.test(line)))
      .map(([n, line]) => `${f.file}:${n}: ${line}`));
  expect(hits).toEqual([]);
});
