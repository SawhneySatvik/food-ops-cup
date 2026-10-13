import type { Metadata } from "next";
import { CaresPage } from "@/components/pages/cares";

export const metadata: Metadata = { title: "Munim Cares" };

export default function Page() {
  return <CaresPage />;
}
