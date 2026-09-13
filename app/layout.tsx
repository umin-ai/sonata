import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata={title:"Stockroom — Stock to cash",description:"Compare selling tokenized stocks with borrowing against them. A cash-access research prototype on Solana.",icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
