"use client";
import { RecordedOnlyNote } from "@munim/ui";
import { t } from "../i18n/index.ts";
import { useStore } from "./store.tsx";

const METHOD = { cash: "order.pay.method.cash", card: "order.pay.method.card", upi: "order.pay.method.upi" } as const;

/** "Pay at the counter — cash, card or UPI." (methods from the country pack via the API; generic line while it lists none)
 *  plus the standing tender label (README §5.6): nothing here moves money. */
export function PayLine() {
  const { payMethods } = useStore();
  const names = (payMethods ?? []).filter((m): m is keyof typeof METHOD => m in METHOD).map((m) => t(METHOD[m]));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")}${t("order.pay.joiner")}${names.at(-1)}` : names[0];
  return (
    <div className="sf-col" data-label="pay-at-counter">
      <p><strong>{list ? t("order.pay.counter_methods", { methods: list }) : t("order.pay.counter")}</strong></p>
      <RecordedOnlyNote />
    </div>
  );
}
