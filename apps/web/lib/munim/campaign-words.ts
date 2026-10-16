// file: lib/munim/campaign-words.ts
// Campaign messages in words (T-128, R67). A campaign names a fixed message template by key (never text a model wrote) and a
// channel; Munim sends nothing (no provider: R40 C6, F-CH open), so every campaign screen says so. Plain TypeScript.
import type { Schemas } from "./types";

type Campaign = Schemas["V1Campaign"];

/** The fixed message templates by key: what a customer would read. No figure in them. */
const MESSAGE: Record<string, string> = {
  "campaign.win_back": "We've missed you at Cobnut Bakehouse. Your favourites come out of the oven every morning — come by this week.",
};
export const messageWords = (key: string): string => MESSAGE[key] ?? "A message from the business";

export const CHANNEL: Record<Campaign["channel"], string> = { sms: "Text message", email: "Email" };

export const CAMPAIGN_STATUS: Record<Campaign["status"], { words: string; tone: "new" | "ready" | "done" }> = {
  queued: { words: "Approved · not sent", tone: "new" },
  sent: { words: "Sent (simulated)", tone: "ready" },
  cancelled: { words: "Cancelled", tone: "done" },
};

/** Every campaign and campaign proposal carries this line (hard rule 5: simulated means labelled). */
export const NO_SEND = "Simulated: Munim has no message provider, so no message leaves Munim. These customers are synthetic.";
/** Beside "Record as sent": what the button records. */
export const RECORD_SENT = "Records that this message went out, for the demo. Nothing is sent.";
