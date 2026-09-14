import type { Metadata } from "next";
import "./globals.css";
import "./devnet/devnet.css";
export const metadata: Metadata={title:"Stockroom — Devnet stock markets",description:"Explore Stockroom’s four mock stock markets on Solana Devnet. Supply demo USD, borrow against mock stocks, manage your position, and follow onchain activity.",icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
