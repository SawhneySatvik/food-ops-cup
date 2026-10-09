// Number grammar (03-architecture §1.7, 04-agent-framework §4 check 2). Model prose may carry numbers,
// dates and quotations only as refs; everything outside a well-formed ref is checked here. The word and
// symbol lists are the single definition in @munim/contracts/grammar — nothing is listed locally.
import { anyRefTokens, parseRef } from "@munim/contracts";
import { DEVANAGARI_NUMBER_WORDS, ENGLISH_CARDINALS, MAGNITUDE_SUFFIXES, NUMBER_SYMBOLS, NUMERIC_CHAR } from "@munim/contracts/grammar";

export type GrammarRule = "malformed_ref" | "numeric_char" | "number_symbol" | "magnitude_suffix" | "number_word" | "typed_quotation";
export type GrammarResult = { ok: true } | { ok: false; rule: GrammarRule; match: string };

// Private-use placeholders for refs: not letters, marks or numerics, so they bound words and never match.
const CITE = "";
const SNAP = "";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const WORDS = new Set([...ENGLISH_CARDINALS, ...DEVANAGARI_NUMBER_WORDS].map((w) => w.normalize("NFC").toLowerCase()));
// Letters + combining marks (Devanagari vowel signs, virama and nukta are \p{M}); hyphenated compounds
// are one token. JS `\b` is ASCII-only, so words are matched as maximal runs instead.
const WORD = /[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/gu;
// Case-sensitive: `k`, `L`, `Cr` attached to a ref, not followed by a letter (so `⟩kg` is a unit).
const SUFFIX = new RegExp(`[${CITE}${SNAP}](${MAGNITUDE_SUFFIXES.map(esc).join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "u");
// Double-quote family: always a quotation. Allowed only when the quoted content is a single cite ref.
const DQ = "\"“”„‟«»‹›「」『』";
const QUOTED_CITE = new RegExp(`[${DQ}]\\s*${CITE}\\s*[${DQ}]`, "gu");
const ANY_DQ = new RegExp(`[${DQ}]`, "u");
// Single quotes pair only when they are not apostrophes (not inside or at the end of a word).
const SINGLE_PAIR = /(?<![\p{L}\p{M}\p{N}])['‘‚]([^'‘’‚]+?)['’](?![\p{L}\p{M}\p{N}])/gu;

export function checkGrammar(text: string): GrammarResult {
  const s = text.normalize("NFC");
  for (const m of s.matchAll(anyRefTokens())) if (!parseRef(m[0])) return { ok: false, rule: "malformed_ref", match: m[0] };
  const prose = s.replace(anyRefTokens(), (t) => (parseRef(t)!.kind === "snap" ? SNAP : CITE));

  const n = NUMERIC_CHAR.exec(prose);
  if (n) return { ok: false, rule: "numeric_char", match: n[0] };
  const sym = NUMBER_SYMBOLS.find((x) => prose.includes(x));
  if (sym) return { ok: false, rule: "number_symbol", match: sym };
  const suf = SUFFIX.exec(prose);
  if (suf) return { ok: false, rule: "magnitude_suffix", match: suf[1]! };
  for (const [w] of prose.matchAll(WORD)) {
    const lw = w.toLowerCase();
    if (WORDS.has(lw) || lw.split("-").some((p) => WORDS.has(p))) return { ok: false, rule: "number_word", match: w };
  }
  const unquoted = prose.replace(QUOTED_CITE, CITE);
  const dq = ANY_DQ.exec(unquoted);
  if (dq) return { ok: false, rule: "typed_quotation", match: dq[0] };
  for (const m of unquoted.matchAll(SINGLE_PAIR)) if (m[1]!.trim() !== CITE) return { ok: false, rule: "typed_quotation", match: "'" };
  return { ok: true };
}
