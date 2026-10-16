// file: components/storefront-theme.tsx
"use client";
// The storefront wears the page its owner published (T-128): its theme as CSS variables on the shop's wrapper, and its home
// sections for the home page. One read per page load (GET /v1/storefront/page); until it answers, or when nothing is
// published or the read fails, the shop shows Cobnut's built-in look, which is what it looks like today. Staff screens are
// outside this wrapper and never wear a storefront theme.
import { createContext, useContext, useEffect, useState } from "react";
import { munim } from "@/lib/munim";
import { BUILT_IN, themeVars, type PageDoc } from "@/lib/munim/page-theme";

const PageContext = createContext<PageDoc>(BUILT_IN);
/** The home page's document: the live one, else the built-in one. */
export const usePageDoc = (): PageDoc => useContext(PageContext);

export function StorefrontTheme({ children }: { children: React.ReactNode }) {
  const [doc, setDoc] = useState<PageDoc | null>(null);
  useEffect(() => {
    let live = true;
    void munim.getPage().then((r) => { if (live && r.ok && r.data.page) setDoc(r.data.page.doc); });
    return () => { live = false; };
  }, []);
  return (
    <PageContext.Provider value={doc ?? BUILT_IN}>
      <div style={doc ? themeVars(doc.theme) : undefined}>{children}</div>
    </PageContext.Provider>
  );
}
