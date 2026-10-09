import type { ReactNode } from "react";

export const metadata = {
  title: "Munim — synthetic demo",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
