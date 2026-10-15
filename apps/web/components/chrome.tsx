// Static page chrome (server components): the demo bar, which the shop and staff layouts each render, and the footer labels.
import Link from "next/link";
import { RECORDED_ONLY, SAMPLE_DATA } from "@/lib/munim/copy";
import { Hazelnut } from "./art";

export const DEMO_TOP = "Sample shop — orders are not real.";
export const DEMO_TOP_STAFF = "Sample business — synthetic data, simulated suppliers.";
export const DEMO_FOOT = "Demo: all data is synthetic. Payments are recorded, never processed.";

/** `staff` is the same bar in the staff screens' words: there is no shop order to speak of there. */
export function DemoBar({ staff = false }: { staff?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-ink px-4 py-2 text-center text-[14px] font-semibold text-white" role="note">
      {/* The storefront API has no is_demo; Cobnut is synthetic wherever it runs, so the shop always says so. */}
      <span className="rounded-full border-[1.5px] border-dashed border-white px-2.5 leading-6">{SAMPLE_DATA}</span>
      {staff ? DEMO_TOP_STAFF : DEMO_TOP}
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t-[1.5px] border-line bg-card">
      <div className="wrap grid gap-8 pt-10 pb-6 sm:grid-cols-[1fr_auto] sm:items-start">
        <div className="max-w-[46ch] space-y-2">
          <p className="display flex items-center gap-2 text-[22px]">
            <Hazelnut size={26} /> Cobnut Bakehouse
          </p>
          <p className="text-muted">A synthetic bakehouse built on Munim&apos;s storefront API.</p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-10 text-[16px] font-semibold sm:flex sm:gap-x-8">
          <Link className="inline-flex min-h-12 items-center no-underline hover:underline" href="/">Menu</Link>
          <Link className="inline-flex min-h-12 items-center no-underline hover:underline" href="/story">Our story</Link>
          <Link className="inline-flex min-h-12 items-center no-underline hover:underline" href="/cares">Munim Cares</Link>
          <Link className="inline-flex min-h-12 items-center no-underline hover:underline" href="/staff/sign-in">Staff sign-in</Link>
        </nav>
      </div>
      <div className="wrap border-t border-bg-deep py-5">
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-[14px] text-muted">
          <li>{DEMO_TOP}</li>
          <li>{DEMO_FOOT}</li>
          <li>{RECORDED_ONLY}</li>
        </ul>
      </div>
    </footer>
  );
}
