import type { Metadata } from "next";
import "./globals.css";
import "./devnet/devnet.css";
export const metadata: Metadata={title:"Stockroom — Stock-backed credit",description:"Plan a stock-backed loan, explore downside scenarios, and manage the full example loan lifecycle. Read live Solana wallet and Kamino position data.",icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
