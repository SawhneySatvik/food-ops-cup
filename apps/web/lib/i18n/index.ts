// The one messages module (design-system §8): packages/ui's keys plus one file per surface, each owned by its lane, so
// parallel lanes never edit the same file. test/i18n.test.ts fails on a key defined twice.
import { createT, uiMessages, type T } from "@munim/ui/i18n";
import { cares } from "./messages/cares.ts";
import { chrome } from "./messages/chrome.ts";
import { console as consoleMessages } from "./messages/console.ts";
import { dev } from "./messages/dev.ts";
import { kds } from "./messages/kds.ts";
import { order } from "./messages/order.ts";
import { pos } from "./messages/pos.ts";

export const SOURCES = { ui: uiMessages, chrome, dev, console: consoleMessages, pos, kds, order, cares } as const;
export const messages: Readonly<Record<string, string>> = Object.assign({}, ...Object.values(SOURCES));
export const t: T = createT(messages);
