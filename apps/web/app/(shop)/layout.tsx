// file: app/(shop)/layout.tsx
// The storefront's pages (moved into this route group; their URLs do not change) keep the site footer.
import { SiteFooter } from "@/components/chrome";

export default function ShopLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      {children}
      <SiteFooter />
    </>
  );
}
