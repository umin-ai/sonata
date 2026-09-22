"use client";
import stockPools from "@/lib/liquidity/stock-markets.json";
import { ThemeToggle } from "./theme-provider";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ArrowUpRight,
  Compass,
  FlaskConical,
  Layers3,
  Plus,
  Users,
  Wallet,
  ShieldCheck,
  Sprout,
  Gift,
} from "lucide-react";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Toaster } from "@/components/ui/sonner";
import { WalletConnectButton } from "./onchain/wallet-connect";
import { BrandMark } from "./stockroom-brand";
import { useDemo, money } from "./vault-state";
const destinations = [
  ["/", "Markets", Compass],
  ["/earn", "Pools", Sprout],
  ["/portfolio", "Portfolio", Wallet],
  ["/rewards", "Rewards", Gift],
  ["/activity", "Activity", Activity],
  ["/create", "Launch token", Plus],
  ["/capital", "Treasury", Layers3],
  ["/onchain", "Trade", ShieldCheck],
  ["/ecosystem", "Integrations", Compass],
  ["/lab", "Strategy lab", FlaskConical],
] as const;
function Navigation() {
  const path = usePathname(),
    { setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/" onClick={() => setOpenMobile(false)}>
                <BrandMark />
                <span className="sx-wordmark">sonata</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Explore</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {destinations.slice(0, 5).map(([href, label, Icon]) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      path === href ||
                      (href === "/" && path.startsWith("/vaults/"))
                    }
                    tooltip={label}
                  >
                    <Link href={href} onClick={() => setOpenMobile(false)}>
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Build a market</SidebarGroupLabel>
          <SidebarMenu>
            {destinations.slice(5, 8).map(([href, label, Icon]) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  asChild
                  isActive={path === href}
                  tooltip={label}
                >
                  <Link href={href} onClick={() => setOpenMobile(false)}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-3">
        <SidebarMenu>
          {destinations.slice(8).map(([href, label, Icon]) => (
            <SidebarMenuItem key={href}>
              <SidebarMenuButton
                asChild
                isActive={path === href}
                tooltip={label}
              >
                <Link href={href} onClick={() => setOpenMobile(false)}>
                  <Icon />
                  <span>{label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <div className="sx-sidebar-note group-data-[collapsible=icon]:hidden">
          <span className="sx-status-dot" /> Solana · test environment
          <p>
            Tokenized stock markets.
            <br />
            Devnet test assets only.
          </p>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
export function StockroomShell({
  children,
  reset,
  restore,
  hasBackup,
}: {
  children: ReactNode;
  reset: () => void;
  restore: () => void;
  hasBackup: boolean;
}) {
  const { state, ready } = useDemo(),
    path = usePathname();
  const live = [
    "/",
    "/onchain",
    "/portfolio",
    "/activity",
    "/create",
    "/earn",
    "/capital",
    "/rewards",
    "/community",
  ].includes(path) || (stockPools as {id:string}[]).some(p=>path===`/vaults/${p.id}`);
  const [wallet, setWallet] = useState(false);
  const title = path.startsWith("/lab")
    ? "Strategy prototype"
    : path.startsWith("/vaults/")
      ? "Market detail"
      : path === "/create"
        ? "Launch token"
        : (destinations.find(([url]) => url === path)?.[1] ?? "Workspace");
  return (
    <div className="sr-app" data-demo-ready={ready ? "true" : "false"}>
      <SidebarProvider>
        <SidebarInset className="min-w-0 terminal-shell">
          <header className="sx-topbar terminal-header">
            <Link href="/" className="terminal-brand"><BrandMark /><strong>sonata</strong></Link>
            <nav className="terminal-nav" aria-label="Main navigation">
              {[["/","Markets"],["/earn","Pools"],["/create","Launch"],["/rewards","Rewards"],["/portfolio","Portfolio"]].map(([url,label])=><Link key={url} href={url} aria-current={path===url?"page":undefined}>{label}</Link>)}
            </nav>
            <div className="sx-header-actions">
              <ThemeToggle />
              <Badge variant="outline" className="sx-demo-badge">
                <FlaskConical />
                {live ? "Solana Devnet" : "Local demo"}
              </Badge>
              {live ? (
                <WalletConnectButton />
              ) : (
                <Button
                  variant="outline"
                  disabled={!ready}
                  onClick={() => setWallet(true)}
                >
                  <Wallet />
                  <span>Demo wallet</span>
                  <span className="sx-wallet-value">{money(state.cash)}</span>
                </Button>
              )}
            </div>
          </header>
          <div className="sr-main">
            <Alert className="sx-notice">
              <FlaskConical />
              <AlertDescription>
                <span>
                  {live
                    ? "Actual Devnet transactions. Test tokens have no monetary value."
                    : "Simulated assets and transactions. No real funds."}
                </span>
                <Link href="/ecosystem">
                  Integration status <ArrowUpRight size={13} />
                </Link>
              </AlertDescription>
            </Alert>
            {children}
            <footer className="sx-footer">
              <span>Sonata · Solana Devnet</span><nav className="terminal-footer-links"><Link href="/activity">Activity</Link><Link href="/capital">Treasury</Link><Link href="/ecosystem">Integrations</Link><Link href="/lab">Strategy lab</Link></nav>
              <Badge variant="outline">
                {live ? "Solana Devnet" : "Strategy prototype"}
              </Badge>
            </footer>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster theme="system" position="bottom-right" closeButton />
      <Dialog open={wallet} onOpenChange={setWallet}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your demo wallet</DialogTitle>
            <DialogDescription>
              Saved in this browser. The credit sandbox uses a separate devnet
              wallet.
            </DialogDescription>
          </DialogHeader>
          <div className="sx-wallet-amount">{money(state.cash)}</div>
          <Alert>
            <InfoIcon />
            <AlertDescription>
              A fresh session starts with $10,000 demo USD and no creator
              revenue. Your current session is backed up first.
            </AlertDescription>
          </Alert>
          <DialogFooter className="flex-col! sm:items-stretch">
            <Button
              onClick={() => {
                reset();
                setWallet(false);
              }}
            >
              Start fresh demo · keep backup
            </Button>
            {hasBackup && (
              <Button
                variant="outline"
                onClick={() => {
                  restore();
                  setWallet(false);
                }}
              >
                Restore previous demo
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function InfoIcon() {
  return <FlaskConical />;
}
