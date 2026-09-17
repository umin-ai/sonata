import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "./vault-workspace";
import "./vaults.css";
import "./devnet/devnet.css";
export const metadata: Metadata = {
  title: "Stockroom — Tokenized stock vaults",
  description:
    "Explore tokenized-stock vaults, simulated compounding and community treasuries. Interactive prototype; no real funds.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
