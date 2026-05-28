import "./globals.css";
import type { ReactNode, ReactElement } from "react";

export const metadata = {
  title: "Pump.fun Probability Dashboard",
  description: "Real-time intelligence MVP"
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
