// T-064 console home / draft / Ask, rendered statically from contract-shaped fixtures (no network, no database):
//   • a proposed number shows only as a ref chip formatted by the pack; an unresolved ref reads "cannot verify";
//   • an edit keeps every untouched ref byte-identical and labels the typed leaf with the approver's member id;
//   • role gates: advisor sees no decision buttons + "Read-only access"; a manager on a tenant-wide draft sees no buttons
//     and the owner-only copy; an owner sees Approve / Edit / Reject;
//   • D-done names the decider; the inbox count is the list length and "Inbox zero" when empty;
//   • Ask: core's signature; an abstained answer is the Cannot-verify block with no partial answer; a free digit in
//     answer prose is refused by the renderer (number_grammar).
import { snapRef } from "@munim/contracts/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/console", useRouter: () => ({ refresh() {} }) }));
vi.mock("../lib/actions.ts", () => ({ setScope: async () => {}, setTheme: async () => {}, signOut: async () => {} }));

const { ConsoleProvider } = await import("../lib/console/context.tsx");
const { DraftDecide, withEdits } = await import("../lib/console-home/draft-detail.tsx");
const { InboxPanel } = await import("../lib/console-home/inbox.tsx");
const { AnswerView } = await import("../lib/console-home/ask.tsx");
type Session = Parameters<typeof ConsoleProvider>[0]["session"];
type Detail = Parameters<typeof DraftDecide>[0]["detail"];

const id = (n: number) => `0199e7a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const SNAP = id(900);
const REF = snapRef(SNAP, 0, "unapproved_minor");
const OUTLET = id(2);
const OWNER = id(8);

const session = (role: Session["member"]["role"], inbox: Session["inbox"] = { items: [], nextCursor: null }): Session => ({
  tenant: { id: id(1), name: "Spice Route Group (synthetic)", isDemo: false },
  member: { name: "Asha Rao (synthetic)", role },
  format: { country: "IN", tz: "Asia/Kolkata" },
  outlets: [{ id: OUTLET, name: "Spice Route Central" } as Session["outlets"][number]],
  outletId: null,
  inbox,
  aiEnabled: true,
});

const draft = (over: Partial<Detail["draft"]> = {}): Detail["draft"] => ({
  draft_id: id(10),
  command_type: "finance.dispute.draft.v1",
  payload: { basis: "unapproved_ad_fee", lines: [], currency: "INR", break_ids: [], channel_id: id(11), dispute_id: id(12), total_claimed_minor: REF },
  resolved_refs: [{ path: "/total_claimed_minor", ref: REF, value: 320000 }],
  outlet_ids: [OUTLET],
  source: "intel:finance",
  finding_id: null,
  run_id: id(13),
  evidence: [`snap:${SNAP}`],
  based_on: [{ ref: REF, template_id: "finance.unapproved_deductions", params: {}, expected: 320000 }],
  status: "proposed",
  created_at: "2026-10-13T10:30:00.000Z",
  updated_at: "2026-10-13T10:30:00.000Z",
  ...over,
});
const detail = (over: Partial<Detail> = {}, d: Partial<Detail["draft"]> = {}): Detail => ({
  draft: draft(d), decision: null, unverified_refs: [], history: [{ event: "proposed", at: "2026-10-13T10:30:00.000Z", by: "intel:finance" }], ...over,
});

const renderDraft = (role: Session["member"]["role"], det: Detail, meId: string | null = OWNER) =>
  renderToStaticMarkup(
    <ConsoleProvider session={session(role)}>
      <DraftDecide detail={det} reload={async () => {}} me={{ id: meId, name: "Asha Rao (synthetic)" }} names={{}} />
    </ConsoleProvider>,
  );
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);

test("proposed number = a pack-formatted ref chip; unresolved ref = 'cannot verify'", () => {
  const html = renderDraft("owner", detail());
  expect(html).toContain("₹3,200.00");
  expect(html).toMatch(/data-mu-chip="snap"[^>]*>(?:<svg[\s\S]*?<\/svg>)?₹3,200.00/);
  expect(html).not.toContain("320000");
  const gone = renderDraft("owner", detail({ unverified_refs: [REF] }, { resolved_refs: [] }));
  expect(gone).toContain("cannot verify");
  expect(gone).toContain("This proposal can&#x27;t be checked any more. Reject it with a reason.");
  expect(buttons(gone)).not.toContain("Approve");
  expect(buttons(gone)).toContain("Reject");
});

test("withEdits: untouched refs byte-identical; the typed leaf is {value, typed_by: approver}", () => {
  const lineRef = snapRef(SNAP, 1, "claimed_minor");
  const payload = { total_claimed_minor: REF, lines: [{ claimed_minor: lineRef, order_id: null }], basis: "x" };
  const out = withEdits(payload, new Map([["/total_claimed_minor", 50000]]), OWNER);
  expect(out).toEqual({ total_claimed_minor: { value: 50000, typed_by: OWNER }, lines: [{ claimed_minor: lineRef, order_id: null }], basis: "x" });
  expect(withEdits(payload, new Map(), OWNER)).toEqual(payload);
});

test("role gates: owner decides; advisor read-only; manager on a tenant-wide draft sees owner-only copy, no buttons", () => {
  expect(buttons(renderDraft("owner", detail()))).toEqual(expect.arrayContaining(["Reject", "Edit", "Approve"]));
  // No member id (a manager: /v1/members is owner-only) → no Edit, since typed_by could not name them.
  expect(buttons(renderDraft("manager", detail(), null))).not.toContain("Edit");

  const advisor = renderDraft("advisor", detail());
  expect(advisor).toContain("Read-only access");
  for (const b of ["Approve", "Edit", "Reject"]) expect(buttons(advisor)).not.toContain(b);

  const wide = renderDraft("manager", detail({}, { outlet_ids: [] }));
  expect(wide).toContain("Your role can&#x27;t approve Dispute proposals. An owner can.");
  for (const b of ["Approve", "Edit", "Reject"]) expect(buttons(wide)).not.toContain(b);
});

test("D-done names who decided; a decided draft has no decision buttons", () => {
  const html = renderDraft("owner", detail({
    decision: { decision_id: id(20), verdict: "rejected", reason: "Already raised", decided_by: { member_id: OWNER, name: "Asha Rao (synthetic)" }, decided_at: "2026-10-13T10:45:00.000Z" },
  }, { status: "rejected" }));
  expect(html).toContain("Already decided by Asha Rao (synthetic) at 13/10/2026 16:15.");
  expect(html).toContain("Reason: Already raised");
  for (const b of ["Approve", "Edit", "Reject"]) expect(buttons(html)).not.toContain(b);
});

test("D-stale and D-fail from the draft's status", () => {
  const stale = renderDraft("owner", detail({ history: [{ event: "stale", at: "2026-10-13T10:40:00.000Z", by: { member_id: OWNER, name: "Asha" }, changes: [{ ref: REF, value: 320000, now_ref: null, now: null }] }] }, { status: "stale" }));
  expect(stale).toContain("This proposal is out of date: the numbers it relied on have changed.");
  expect(stale).toContain("cannot verify");
  expect(buttons(stale)).not.toContain("Approve");
  expect(renderDraft("owner", detail({}, { status: "failed" }))).toContain("Approved, but it could not be applied. Nothing was changed.");
});

test("inbox: count = list length; empty = 'Inbox zero'", () => {
  const empty = renderToStaticMarkup(<ConsoleProvider session={session("owner")}><InboxPanel /></ConsoleProvider>);
  expect(empty).toContain("Inbox zero. New proposals appear here.");
  const items = [{ kind: "draft" as const, draft: draft() }, { kind: "draft" as const, draft: draft({ draft_id: id(11) }) }];
  const two = renderToStaticMarkup(<ConsoleProvider session={session("owner", { items, nextCursor: null })}><InboxPanel /></ConsoleProvider>);
  expect(two).toContain('data-count="2"');
  expect(two.match(/<li class="ch-item"/g)).toHaveLength(2);
  expect(two).toContain("Dispute · Spice Route Central");
  expect(two).toContain("proposed by Finance");
});

const answer = (segments: { text: string; refs: string[] }[], abstained: boolean, resolved: { ref: string; value: number }[] = []) => ({
  question: "@Finance show me last week's payouts",
  answer: {
    answer_id: id(30),
    envelope: { answer_id: id(30), segments, abstained, ...(abstained ? { reason_code: "missing_ref" as const } : {}) },
    resolved_refs: resolved,
    signature: { key: "answer.signature.via_manager" as const, specialist: "finance", name_key: "specialist.finance.name" },
  },
});
const renderAnswer = (turn: ReturnType<typeof answer>) =>
  renderToStaticMarkup(<ConsoleProvider session={session("owner")}><ol><AnswerView turn={turn as never} /></ol></ConsoleProvider>);

test("Ask: signature from core; abstained = Cannot-verify block, no partial answer", () => {
  const html = renderAnswer(answer([], true));
  expect(html).toContain("Finance · via Manager");
  expect(html).toContain("Cannot verify: a statement had no source.");
  expect(html).not.toContain("mu-reftext\"");
  // Nothing tried: "What was checked" says so plainly instead of an empty heading.
  expect(html).toContain('data-checked="none"');
  expect(html).toContain("No source in your records could be cited for this question.");
  // Tried refs (bare ids in segments' refs): listed, each openable as snapshot rows.
  const tried = renderAnswer(answer([{ text: "The payouts could not be matched.", refs: [`snap:${SNAP}`] }], true));
  expect(tried).toContain("What was checked");
  expect(tried).toContain('data-mu-chip="checked"');
  expect(tried).not.toContain('data-checked="none"');
});

test("Ask: a cited answer shows chips + 'Checked: 1 sources'; a free digit in prose is refused", () => {
  const cited = renderAnswer(answer([{ text: `Swiggy kept ${REF} in ad fees.`, refs: [`snap:${SNAP}`] }], false, [{ ref: REF, value: 320000 }]));
  expect(cited).toContain("₹3,200.00");
  expect(cited).toContain("Checked: 1 sources");
  const forged = renderAnswer(answer([{ text: "Swiggy kept 3200 rupees in ad fees.", refs: [] }], false));
  expect(forged).toContain("Cannot verify: the answer contained a number that does not come from your records.");
  expect(forged).not.toContain("3200");
});
