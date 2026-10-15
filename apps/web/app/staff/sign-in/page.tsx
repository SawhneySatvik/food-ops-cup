// file: app/staff/sign-in/page.tsx
import { StaffSignIn } from "@/components/staff/sign-in";

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function SignInPage() {
  return <StaffSignIn />;
}
