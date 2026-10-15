// Interface icons, drawn by hand for this project (24 × 24, currentColor strokes, round caps). No icon pack.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const BagIcon = (p: P) => <Svg {...p}><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" /><path d="M9 10V6.5a3 3 0 0 1 6 0V10" /></Svg>;
export const PlusIcon = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const MinusIcon = (p: P) => <Svg {...p}><path d="M5 12h14" /></Svg>;
export const CloseIcon = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const ClockIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
export const PhoneIcon = (p: P) => <Svg {...p}><path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z" /></Svg>;
export const PinIcon = (p: P) => <Svg {...p}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></Svg>;
export const CheckIcon = (p: P) => <Svg {...p}><path d="m5 12.5 4.2 4L19 7" /></Svg>;
export const AlertIcon = (p: P) => <Svg {...p}><path d="M12 3.5 2.8 19.5h18.4z" /><path d="M12 10v4.2M12 17.2v.1" /></Svg>;
export const OfflineIcon = (p: P) => <Svg {...p}><path d="M7 18.5h10.5a3.8 3.8 0 0 0 .6-7.5A5.6 5.6 0 0 0 7.4 9.6 4.5 4.5 0 0 0 7 18.5z" /><path d="M3.5 3.5l17 17" /></Svg>;
export const LeafIcon = (p: P) => <Svg {...p}><path d="M5 19c0-8 5-13.5 14-14-.4 9-6 14-14 14z" /><path d="M5 19 13 11" /></Svg>;
export const ChevronIcon = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const MoonIcon = (p: P) => <Svg {...p}><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" /></Svg>;
export const PauseIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M10 9v6M14 9v6" /></Svg>;
export const GiftIcon = (p: P) => <Svg {...p}><rect x="4" y="9" width="16" height="11" rx="1.5" /><path d="M3 9h18M12 9v11M12 9c-2-4-6-4-6-1.5S10 9 12 9zm0 0c2-4 6-4 6-1.5S14 9 12 9z" /></Svg>;

/** The "open" status dot: a filled circle, always beside a word. */
export const Dot = ({ className = "" }: { className?: string }) => <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${className}`} />;
