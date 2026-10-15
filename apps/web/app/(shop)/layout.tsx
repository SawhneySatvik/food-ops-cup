// file: app/(shop)/layout.tsx
// The storefront's pages (moved into this route group; their URLs do not change) keep the demo bar and the site footer.
import { DemoBar, SiteFooter } from "@/components/chrome";

export default function ShopLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <DemoBar />
      {children}
      <SiteFooter />
    </>
  );
}
