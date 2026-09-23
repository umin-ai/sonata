import { ThemeProvider } from "./theme-provider";
import type { Metadata } from "next";
import "./globals.css";
import { LiveProvider } from "./onchain/live-session";
import { AppProvider } from "./vault-workspace";
import "./credit-theme.css";
import "./shadcn-workspace.css";
import "./devnet/devnet.css";
import "./neumorphic.css";
import "./exchange.css";
import "./sonata.css";
import "./sonata-hud.css";
export const metadata: Metadata = {
  title: "Sonata — Stock-powered markets",
  description:
    "Create and trade mock-stock paired markets on Solana Devnet. Track real fees, treasury allocations and wallet balances.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider><LiveProvider>
          <AppProvider>{children}</AppProvider>
        </LiveProvider></ThemeProvider>
      </body>
    </html>
  );
}
