import { notFound } from "next/navigation";

export const instant = false;

// Any /staff/... address no screen owns lands here, so it gets the staff "Not found." (app/staff/not-found.tsx) and not the shop's.
export default function Page() {
  notFound();
}
