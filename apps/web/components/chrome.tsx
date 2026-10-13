// Static page chrome rendered by the root layout (server component): the demo bar and the footer labels.
import Link from "next/link";
import { RECORDED_ONLY } from "@/lib/munim/copy";
import { Hazelnut } from "./art";

export const DEMO_TOP = "Sample shop — orders are not real.";
export const DEMO_FOOT = "Demo: all data is synthetic. Payments are recorded, never processed.";

export function DemoBar() {
  return (
    <div className="bg-ink px-4 py-2 text-center text-[14px] font-semibold text-white" role="note">
      {DEMO_TOP}
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t-[1.5px] border-line bg-card">
      <div className="wrap grid gap-6 py-10 sm:grid-cols-[1.2fr_1fr]">
        <div className="space-y-2">
          <p className="display flex items-center gap-2 text-[22px]">
            <Hazelnut size={26} /> Cobnut Bakehouse
          </p>
          <p className="text-[14px] text-muted">A synthetic bakehouse built on Munim&apos;s storefront API.</p>
          <p className="text-[14px] font-semibold">{DEMO_TOP}</p>
          <p className="text-[14px] font-semibold">{DEMO_FOOT}</p>
          <p className="text-[14px]">{RECORDED_ONLY}</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap content-start gap-x-6 gap-y-1 text-[16px]">
          <Link className="inline-flex min-h-12 items-center" href="/">Menu</Link>
          <Link className="inline-flex min-h-12 items-center" href="/story">Our story</Link>
          <Link className="inline-flex min-h-12 items-center" href="/cares">Munim Cares</Link>
        </nav>
      </div>
    </footer>
  );
}
