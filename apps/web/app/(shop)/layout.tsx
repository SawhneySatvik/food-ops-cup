// file: app/(shop)/layout.tsx
// The storefront's pages (moved into this route group; their URLs do not change) keep the demo bar and the site footer, and
// wear the page their owner published (T-128, components/storefront-theme.tsx).
import { DemoBar, SiteFooter } from "@/components/chrome";
import { StorefrontTheme } from "@/components/storefront-theme";

export default function ShopLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <StorefrontTheme>
      <DemoBar />
      {children}
      <SiteFooter />
    </StorefrontTheme>
  );
}
