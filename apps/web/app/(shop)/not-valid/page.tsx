import type { Metadata } from "next";
import { NotValidPage } from "@/components/pages/not-valid";

export const metadata: Metadata = { title: "This link isn't valid" };

export default function Page() {
  return <NotValidPage />;
}
