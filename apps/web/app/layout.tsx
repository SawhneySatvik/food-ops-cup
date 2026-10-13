import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import "@munim/ui/tokens.css";
import "@munim/ui/styles.css";
import { COOKIE } from "../lib/session/index.ts";

// Inter (SIL OFL, founder approved), the one family (design-system §3). latin-ext carries ₹ (U+20B9); packages/ui
// reads only var(--font-sans) (H6).
const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Munim — synthetic demo",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F6F2" },
    { media: "(prefers-color-scheme: dark)", color: "#151513" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // H4: the theme cookie is read on the server, so the first paint is already in the right theme.
  const theme = (await cookies()).get(COOKIE.theme)?.value;
  return (
    <html lang="en" className={inter.variable} data-theme={theme === "light" || theme === "dark" ? theme : undefined} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
