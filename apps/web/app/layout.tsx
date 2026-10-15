import type { Metadata, Viewport } from "next";
import { body, display } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Cobnut Bakehouse — order ahead, pick up warm (sample shop)", template: "%s · Cobnut Bakehouse (sample shop)" },
  description: "A synthetic bakehouse storefront built on Munim's API. Sample shop — orders are not real; payments are recorded, never processed.",
};

export const viewport: Viewport = { themeColor: "#fbf4ea" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN" className={`${display.variable} ${body.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
