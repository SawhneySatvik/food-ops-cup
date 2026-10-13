// Console chrome: Ask is removed — not errored — when AI is off (S-aioff); the inbox badge is the held list's length,
// "N+" when the list is capped (R40 C3); the demo badge follows tenant.is_demo.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/console", useRouter: () => ({ refresh() {} }) }));
vi.mock("../lib/actions.ts", () => ({ setScope: async () => {}, setTheme: async () => {}, signOut: async () => {} }));

const { ConsoleChrome } = await import("../lib/console/chrome.tsx");
const { ConsoleProvider } = await import("../lib/console/context.tsx");
type Session = Parameters<typeof ConsoleProvider>[0]["session"];

const base: Session = {
  tenant: { id: "t", name: "Spice Route Group (synthetic)", isDemo: false },
  member: { name: "Asha Rao (synthetic)", role: "owner" },
  format: { country: "IN", tz: "Asia/Kolkata" },
  outlets: [],
  outletId: null,
  inbox: { items: [{} as never, {} as never, {} as never], nextCursor: null },
  aiEnabled: true,
};
const render = (s: Partial<Session>) => renderToStaticMarkup(<ConsoleProvider session={{ ...base, ...s }}><ConsoleChrome /></ConsoleProvider>);

test("Ask is in the chrome when AI is on and absent when it is off", () => {
  expect(render({})).toContain(">Ask<");
  const off = render({ aiEnabled: false });
  expect(off).not.toContain("Ask");
  expect(off).not.toContain("console/ask");
});

test("inbox badge = list length; N+ when capped; hidden for members who cannot read the inbox", () => {
  expect(render({})).toContain('aria-label="3 in inbox"');
  expect(render({ inbox: { items: [{} as never], nextCursor: "c" } })).toContain('aria-label="1+ in inbox"');
  expect(render({ inbox: null })).not.toContain("in inbox");
});

test("demo badge follows tenant.is_demo", () => {
  expect(render({})).not.toContain("Sample data — synthetic, for demonstration");
  expect(render({ tenant: { ...base.tenant, isDemo: true } })).toContain("Sample data — synthetic, for demonstration");
});
