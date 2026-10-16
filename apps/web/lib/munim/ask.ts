// file: lib/munim/ask.ts
// Ask Munim helpers (13). Who a question will go to (core's leading-@Name rule, mirrored for the hint only: core
// decides), the answer's signature in words, and how to find out what happened to a question whose request was lost.
// That is always by looking, never by asking again: POST /v1/ask is not a command, and a resend can add a second
// turn. Plain TypeScript, no React.
import type { StaffClient } from "./staff";
import { specialistName } from "./staff-copy";
import type { Schemas } from "./types";

export type Specialist = Schemas["V1SpecialistsResponse"]["items"][number];
export type Thread = Schemas["V1Thread"];
export type ThreadItem = Schemas["V1ThreadsResponse"]["items"][number];
export type Turn = Thread["turns"][number];
export type Answer = NonNullable<Turn["answer"]>;

/** core's limit on a question (after trimming). */
export const QUESTION_MAX = 2000;

/** Only a LEADING @word counts; it ends at the end, a space, "," ":" or ";" (so "@b.c" is not a mention). */
const LEADING = /^\s*@([A-Za-z][A-Za-z0-9_]*)(?=$|[\s,:;])/u;

/** Who this question will go to: a specialist id, or "manager". `unknown` is an @word that names no specialist
 *  (core then answers as if there were no mention). In a specialist's thread, a question with no mention goes to
 *  that specialist. */
export function addressee(question: string, specialists: readonly Specialist[], threadSpecialist: string | null): { to: string; unknown: string | null } {
  const m = LEADING.exec(question);
  const fallback = threadSpecialist ?? "manager";
  if (!m) return { to: fallback, unknown: null };
  const hit = specialists.find((s) => s.kind === "specialist" && s.aliases.includes(m[1]!.toLowerCase()));
  return hit ? { to: hit.id, unknown: null } : { to: fallback, unknown: m[1]! };
}

/** The eight specialists the "@Name" picker offers (the Manager answers when nobody is named). */
export const pickable = (all: readonly Specialist[]): Specialist[] => all.filter((s) => s.kind === "specialist");

/** The question with this specialist's mention at the very start (replacing any mention already there). The word is
 *  one of the specialist's own aliases, letters only, so core's rule matches it. */
export function withMention(question: string, s: Specialist): string {
  const alias = s.aliases.find((a) => /^[a-z]+$/.test(a)) ?? s.id;
  const rest = question.replace(LEADING, "").replace(/^[\s,:;]+/, "");
  return `@${alias.charAt(0).toUpperCase()}${alias.slice(1)} ${rest}`;
}

/** "Kitchen · via Manager", or "Manager" for an answer the Manager gave itself. */
export const signatureWords = (sig: Answer["signature"]): string =>
  sig.key === "answer.signature.via_manager" ? `${specialistName(sig.specialist)} · via Manager` : "Manager";

/** After a lost POST /v1/ask (network error, the client's timeout, or a gateway's 504): looks, never resends. Core writes the turn (and,
 *  for a first question, the thread) only after the answer is stored, so a turn past `turnsBefore` in this thread,
 *  or a thread of this person's that was not in `before`, is the answer. Returns that thread's id, or null when it
 *  is not there (yet: core may still be working on it). */
export async function findLostAnswer(client: StaffClient, memberId: string, threadId: string | null, turnsBefore: number, before: ReadonlySet<string>): Promise<string | null> {
  if (threadId) {
    const t = await client.getThread(threadId);
    return t.ok && t.data.turns.length > turnsBefore ? threadId : null;
  }
  const l = await client.listThreads();
  return (l.ok ? l.data.items.find((i) => i.created_by === memberId && !before.has(i.thread_id))?.thread_id : undefined) ?? null;
}
