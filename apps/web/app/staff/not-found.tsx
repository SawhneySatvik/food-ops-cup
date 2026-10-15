import Link from "next/link";
import { FullPage } from "@/components/ui";

export default function StaffNotFound() {
  return (
    <FullPage title="Not found." action={<Link href="/staff" className="btn btn-primary">Back to home</Link>}>
      <p>There is nothing at this address.</p>
    </FullPage>
  );
}
