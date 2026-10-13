"use client";
// P2 Options sheet. No network call and no sum: each option shows its own price-delta row beside the item's price row;
// the line's price is core's, shown in the cart after the preview.
import { Button, Sheet, type Formatter } from "@munim/ui";
import { useState } from "react";
import { t } from "../../lib/i18n/index.ts";
import { entryName, firstUnmet, type MenuEntry } from "../../lib/pos/logic.ts";

export function OptionsSheet({ entry, fmt, onClose, onAdd }: {
  entry: MenuEntry | null; fmt: Formatter; onClose: () => void; onAdd: (e: MenuEntry, optionIds: string[]) => void;
}) {
  return (
    <Sheet open={entry !== null} onClose={onClose} side="bottom" title={entry ? entryName(entry) : ""}>
      {entry && <Picker key={entry.item_id} entry={entry} fmt={fmt} onClose={onClose} onAdd={onAdd} />}
    </Sheet>
  );
}

function Picker({ entry, fmt, onClose, onAdd }: { entry: MenuEntry; fmt: Formatter; onClose: () => void; onAdd: (e: MenuEntry, ids: string[]) => void }) {
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [unmet, setUnmet] = useState<string | null>(null);
  const toggle = (gid: string, oid: string, max: number) => setPicks((p) => {
    const cur = p[gid] ?? [];
    if (cur.includes(oid)) return { ...p, [gid]: cur.filter((x) => x !== oid) };
    return { ...p, [gid]: max === 1 ? [oid] : cur.length < max ? [...cur, oid] : cur };
  });
  const group = firstUnmet(entry.option_groups, picks);
  const submit = () => {
    if (group) { setUnmet(group.option_group_id); return; }
    onAdd(entry, Object.values(picks).flat());
  };
  return (
    <>
      <p className="pos-muted">{fmt.money(entry.price_minor, entry.currency)}</p>
      {entry.option_groups.map((g) => (
        <fieldset key={g.option_group_id} className="pos-group" data-shake={unmet === g.option_group_id || undefined}>
          <legend>
            {g.display_name ?? g.name_key} · {g.required ? t("pos.p2.required") : g.max_select === 1 ? t("pos.p2.choose_one") : t("pos.p2.choose_up_to", { max: String(g.max_select) })}
          </legend>
          {g.options.map((o) => {
            const on = (picks[g.option_group_id] ?? []).includes(o.option_id);
            return (
              <label key={o.option_id} className="pos-option">
                <input type={g.max_select === 1 ? "radio" : "checkbox"} name={g.option_group_id} checked={on} onChange={() => toggle(g.option_group_id, o.option_id, g.max_select)} />
                <span>{o.display_name ?? o.name_key}</span>
                <span className="pos-amount">{fmt.money(o.price_delta_minor, o.currency)}</span>
              </label>
            );
          })}
          {unmet === g.option_group_id && <p role="alert" className="pos-refusal">{t("pos.p2.choose_for", { group: g.display_name ?? g.name_key })}</p>}
        </fieldset>
      ))}
      <p className="pos-muted">{t("pos.p2.note")}</p>
      <div className="pos-sheet-actions">
        <Button onClick={onClose}>{t("pos.p2.cancel")}</Button>
        <Button variant="primary" size="lg" aria-disabled={group !== null} onClick={submit}>{t("pos.p2.add")}</Button>
      </div>
    </>
  );
}
