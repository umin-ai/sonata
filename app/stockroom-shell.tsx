"use client";
import stockPools from "@/lib/liquidity/stock-markets.json";
import { ThemeToggle } from "./theme-provider";
import { useState, type ReactNode } from "react";
import Link from "@/app/plain-link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ArrowUpRight,
  Compass,
  FlaskConical,
  Layers3,
  Plus,
  Wallet,
  Sprout,
  Gift,
  BookOpen,
} from "lucide-react";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbPage,
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
  ["/capital", "My tokens", Layers3],
  ["/ecosystem", "How it works", BookOpen],
] as const;
function Navigation() {
  const path = usePathname();
  return (
    <Sidebar collapsible="none" className="sonata-permanent-sidebar">
      <SidebarHeader className="p-4">
        <span className="sonata-sidebar-edition" aria-hidden="true">SONATA / MARKETS <span>{"///"}</span></span>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/" aria-label="Sonata home">
                <BrandMark />
                <span className="sx-wordmark">sonata</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel><span>01</span> Explore</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {destinations.slice(0, 5).map(([href, label, Icon]) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      path === href ||
                      (href === "/" &&
                        (path.startsWith("/vaults/") ||
                          path.startsWith("/markets/")))
                    }
                    tooltip={label}
                  >
                    <Link href={href} aria-label={label} title={label} className={href === "/create" ? "sonata-sidebar-launch" : undefined}>
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
          <SidebarGroupLabel><span>02</span> Create & trade</SidebarGroupLabel>
          <SidebarMenu>
            {destinations.slice(5, 7).map(([href, label, Icon]) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  asChild
                  isActive={path === href}
                  tooltip={label}
                >
                  <Link href={href} aria-label={label} title={label} className={href === "/create" ? "sonata-sidebar-launch" : undefined}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel><span>03</span> Learn</SidebarGroupLabel>
          <SidebarMenu>
            {destinations.slice(7).map(([href, label, Icon]) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  asChild
                  isActive={path === href}
                  tooltip={label}
                >
                  <Link href={href} aria-label={label} title={label} className={href === "/create" ? "sonata-sidebar-launch" : undefined}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

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
    "/ecosystem",
  ].includes(path) || path.startsWith("/markets/") || (stockPools as {id:string}[]).some(p=>path===`/vaults/${p.id}`);
  const [wallet, setWallet] = useState(false);
  const title = path.startsWith("/lab")
    ? "Strategy prototype"
    : path.startsWith("/vaults/") || path.startsWith("/markets/")
      ? "Market detail"
      : path === "/create"
        ? "Launch token"
        : (destinations.find(([url]) => url === path)?.[1] ?? "Workspace");
  return (
    <div className="sr-app" data-demo-ready={ready ? "true" : "false"}>
      <SidebarProvider open={true} style={{ "--sidebar-width": "14rem" } as React.CSSProperties}>
        <Navigation />
        <SidebarInset className="min-w-0 terminal-shell">
          <header className="sx-topbar">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>{title}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
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
                    ? "Test tokens have no monetary value."
                    : "Simulated assets and transactions. No real funds."}
                </span>
                <Link href="/ecosystem">
                  How it works <ArrowUpRight size={13} />
                </Link>
              </AlertDescription>
            </Alert>
            {children}

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
