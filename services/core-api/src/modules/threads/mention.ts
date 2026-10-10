// `@Name` addressing (F9): deterministic, never a model. Only a LEADING mention counts (an email or a mid-sentence `@`
// is text). The token is matched case-insensitively against the registry aliases of the eight specialists; the
// Manager, the Forecast service and an unknown name address no one, so the Manager answers (T-088a orchestrator
// ruling; BOARD/04 §12.2 asked for 422 `unknown_specialist`, which is not a registered reason code — flagged).
import { SPECIALIST_REGISTRY } from "@munim/contracts/intel";

const ALIAS = new Map(
  SPECIALIST_REGISTRY.specialists.filter((s) => s.kind === "specialist").flatMap((s) => s.aliases.map((a) => [a, s.id] as const)),
);
// The token ends at the end of the text, whitespace, or `,` `:` `;` — so `@b.c` is not a mention of `b`.
const LEADING = /^\s*@([A-Za-z][A-Za-z0-9_]*)(?=$|[\s,:;])/u;

/** The addressed specialist's id, or null (no leading mention, the Manager, or an unknown name). */
export function addressedTo(question: string): string | null {
  const m = LEADING.exec(question);
  return m ? (ALIAS.get(m[1]!.toLowerCase()) ?? null) : null;
}
