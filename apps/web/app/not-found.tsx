import { DemoBar } from "@/components/chrome";
import { NotValidPage } from "@/components/pages/not-valid";

// Outside both route groups, so it brings the demo bar itself.
export default function NotFound() {
  return (
    <>
      <DemoBar />
      <NotValidPage />
    </>
  );
}
