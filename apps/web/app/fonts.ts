// Both families are SIL OFL, downloaded at build time by next/font and served from this site (works on any host).
// Inter's latin-ext subset carries the rupee sign (U+20B9) and tabular figures; money never uses the serif.
import { Fraunces, Inter } from "next/font/google";

export const display = Fraunces({ subsets: ["latin"], weight: ["600"], style: ["normal", "italic"], variable: "--font-display-face", display: "swap" });
export const body = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-body-face", display: "swap" });
