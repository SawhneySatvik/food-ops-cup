// Drafts waiting: only cares listing drafts, each linked to T-064's approval screen (no second approval flow), none of
// the proposal's numbers repeated here, and the block is removed (not errored) when AI is off (S-aioff).
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/console/cares", useRouter: () => ({ refresh() {} }) }));
const { ConsoleProvider } = await import("../lib/console/context.tsx");
const { DraftsWaiting } = await import("../lib/cares/listings.tsx");
type Session = Parameters<typeof ConsoleProvider>[0]["session"];

const draft = (id: string, command_type: string) =>
  ({ kind: "draft", draft: { draft_id: id, command_type, payload: { lines: [{ qty_milli: 777000 }] }, outlet_ids: ["o1"], created_at: "2026-10-13T10:30:00.000Z" } }) as never;
const base: Session = {
  tenant: { id: "t", name: "T", isDemo: false }, member: { name: "A", role: "owner" }, format: { country: "IN", tz: "Asia/Kolkata" },
  outlets: [{ id: "o1", name: "Spice Route North", tz: "Asia/Kolkata" } as never], outletId: null,
  inbox: { items: [draft("d-cares", "cares.listing.publish.v1"), draft("d-other", "imports.run.commit.v1")], nextCursor: null }, aiEnabled: true,
};
const render = (s: Partial<Session>) => renderToStaticMarkup(<ConsoleProvider session={{ ...base, ...s }}><DraftsWaiting /></ConsoleProvider>);

test("lists only cares listing drafts, linked to the draft screen, repeating no proposed number", () => {
  const html = render({});
  expect(html).toContain('href="/console/inbox/d-cares"');
  expect(html).not.toContain("d-other");
  expect(html).toContain("Spice Route North");
  expect(html).not.toContain("777");
});

test("nothing renders when AI is off, or when there are no cares drafts", () => {
  expect(render({ aiEnabled: false })).toBe("");
  expect(render({ inbox: { items: [draft("d-other", "imports.run.commit.v1")], nextCursor: null } })).toBe("");
});
