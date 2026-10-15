"use client";
import { NotValid, SiteHeader } from "../ui";

/** The one page for every 404: bad key, unknown outlet or order, missing guest token, unknown route. */
export function NotValidPage() {
  return (
    <>
      <SiteHeader />
      <NotValid />
    </>
  );
}
