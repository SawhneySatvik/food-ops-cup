// Labels whose key comes from data (command type, specialist id, core's signature key): looked up only when the key
// exists, so an unknown value shows its id instead of throwing (t() throws on a missing key).
import { messages, t } from "../i18n/index.ts";

const known = (key: string) => key in messages;

export const draftTypeLabel = (commandType: string): string =>
  known(`console.draft.type.${commandType}`) ? t(`console.draft.type.${commandType}`) : commandType;

/** A specialist's F8 name from its id (= its pack); the id when it has no name. */
export const specialistName = (id: string): string =>
  known(`console.specialist.${id}.name`) ? t(`console.specialist.${id}.name`) : id;

/** Draft `source` → who proposed it: "intel:<pack>" is that specialist; imports and members say so. */
export function proposedBy(source: string): string {
  if (source.startsWith("intel:")) return t("console.inbox.proposed_by", { specialist: specialistName(source.slice(6)) });
  return t(source === "import" ? "console.inbox.from_import" : "console.inbox.from_member");
}

/** Core's composed signature (contracts threads `Signature`): an i18n key + the specialist's name key. Intel never sends
 *  signature text. */
export function signatureText(sig: { key: string; name_key: string }): string {
  const name = known(`console.${sig.name_key}`) ? t(`console.${sig.name_key}`) : sig.name_key;
  return known(`console.${sig.key}`) ? t(`console.${sig.key}`, { specialist: name }) : name;
}

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const severityLabel = (s: string): string =>
  (SEVERITIES as readonly string[]).includes(s) ? t(`console.severity.${s}`) : s;
