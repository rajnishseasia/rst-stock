"use client";

import { ACCOUNT_GLOSSARY_TERMS } from "./account-glossary";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UserMenu } from "@/components/auth/user-menu";
import { Separator } from "@/components/ui/separator";
import {
  Settings,
  ArrowLeft,
  ExternalLink,
  TrendingUp,
  Target,
  Zap,
  CheckCircle2,
  AlertCircle,
  BookOpen,
  Layers,
  DollarSign,
  ArrowUpDown,
  LogIn,
  UserPlus,
  LayoutDashboard,
  SplitSquareHorizontal,
  Info,
  ChevronDown,
  ChevronUp,
  Coins,
  MessageCircle,
  Trophy,
} from "lucide-react";

// Table of contents sections
const SECTIONS = [
  { id: "overview", label: "Overview", icon: BookOpen },
  { id: "create-alpaca", label: "Create Alpaca Account", icon: UserPlus },
  { id: "sign-in", label: "Sign In & Connect", icon: LogIn },
  { id: "fund-crypto", label: "Fund with Crypto", icon: Coins },
  { id: "dashboard", label: "Dashboard Layout", icon: LayoutDashboard },
  { id: "perps", label: "Trade Hyperliquid Perps", icon: Coins },
  { id: "market-order", label: "Place a Market Order", icon: TrendingUp },
  { id: "limit-order", label: "Place a Limit Order", icon: ArrowUpDown },
  { id: "oco-order", label: "Place a Bracket (OCO) Order", icon: Target },
  { id: "signals", label: "Use Signals", icon: Zap },
  { id: "positions", label: "Manage Positions", icon: Layers },
  { id: "copy-trading", label: "Follow & Copy Traders", icon: Trophy },
  { id: "ai-chat", label: "Use AI Chat", icon: MessageCircle },
  { id: "exit-strategy", label: "Set Up Auto-Exits", icon: SplitSquareHorizontal },
  { id: "tips", label: "Tips & Important Notes", icon: Info },
  { id: "glossary", label: "Glossary", icon: BookOpen },
] as const;

const MOBILE_SHORTCUTS = [
  { id: "perps", label: "Perps", icon: Coins },
  { id: "copy-trading", label: "Copy Trading", icon: Trophy },
  { id: "ai-chat", label: "AI Chat", icon: MessageCircle },
] as const;

function StepNumber({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 border border-primary/20">
      {n}
    </span>
  );
}

function InstructionStep({ step, children }: { step: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-start">
      <StepNumber n={step} />
      <div className="text-sm leading-relaxed pt-0.5" suppressHydrationWarning>
        {children}
      </div>
    </div>
  );
}

function SectionCard({ id, title, icon: Icon, description, children }: {
  id: string;
  title: string;
  icon: React.ElementType;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-20">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-xl">{title}</CardTitle>
            {description && (
              <CardDescription className="text-sm mt-1">{description}</CardDescription>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

function CalloutBox({ type, children }: { type: "warning" | "info" | "success" | "tip"; children: React.ReactNode }) {
  const styles = {
    warning: "bg-amber-500/10 border-amber-500/30 text-foreground",
    info: "bg-blue-500/10 border-blue-500/30 text-foreground",
    success: "bg-emerald-500/10 border-emerald-500/30 text-foreground",
    tip: "bg-amber-500/10 border-amber-500/30 text-foreground",
  };
  const iconColors = {
    warning: "text-amber-500",
    info: "text-blue-500",
    success: "text-emerald-500",
    tip: "text-amber-500",
  };
  const icons = {
    warning: AlertCircle,
    info: Info,
    success: CheckCircle2,
    tip: Zap,
  };
  const IconComponent = icons[type];
  return (
    <div className={`flex items-start gap-2.5 p-3 border rounded-lg text-sm ${styles[type]}`}>
      <IconComponent className={`h-4 w-4 mt-0.5 shrink-0 ${iconColors[type]}`} />
      <div className="flex-1 leading-relaxed" suppressHydrationWarning>{children}</div>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
      <Badge variant="outline" className="font-medium shrink-0">{label}</Badge>
      <span className="text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

function CollapsibleSection({ title, children, defaultOpen = false }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-3 text-sm font-medium hover:bg-muted/50 transition-colors text-left"
      >
        {title}
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="px-3 pb-3 border-t pt-3 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

export default function GuidePage() {
  const [activeSection, setActiveSection] = useState("overview");

  useEffect(() => {
    const syncFromHash = () => {
      let requested = window.location.hash.slice(1);
      try {
        requested = decodeURIComponent(requested);
      } catch {
        requested = "";
      }
      const isKnown = SECTIONS.some((section) => section.id === requested);
      const sectionId = isKnown ? requested : "overview";
      setActiveSection(sectionId);
      if (!isKnown) {
        window.history.replaceState(null, "", `#${sectionId}`);
      } else {
        document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  const handleSectionClick = (sectionId: string) => {
    setActiveSection(sectionId);
    window.history.pushState(null, "", `#${encodeURIComponent(sectionId)}`);
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="flex justify-center sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center justify-between px-4 w-full max-w-[1400px]">
          <div className="flex items-center gap-3">
            <Link href="/app">
              <Button variant="ghost" size="sm" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Dashboard
              </Button>
            </Link>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-bold">Trading Tutorial</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/settings">
              <Button variant="ghost" size="icon">
                <Settings className="h-4 w-4" />
              </Button>
            </Link>
            <UserMenu />
          </div>
        </div>
      </header>

      {/* Content with sidebar */}
      <div className="flex justify-center px-4 py-8">
        <div className="flex gap-8 w-full max-w-[1400px]">

          {/* Sidebar Table of Contents - desktop only */}
          <nav className="hidden lg:block w-64 shrink-0">
            <div className="sticky top-20 space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-3">
                Table of Contents
              </p>
              {SECTIONS.map((section) => {
                const Icon = section.icon;
                return (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      handleSectionClick(section.id);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                      activeSection === section.id
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{section.label}</span>
                  </a>
                );
              })}
            </div>
          </nav>

          {/* Main content */}
          <div className="flex-1 max-w-3xl space-y-6">

            {/* ─── OVERVIEW ─── */}
            <SectionCard
              id="overview"
              title="Welcome to Ready Set Trade"
              icon={BookOpen}
              description="Everything you need to connect Alpaca, set up Hyperliquid perps, and use the terminal safely."
            >
              <p className="text-sm text-muted-foreground leading-relaxed">
                Ready Set Trade is a web-based trading terminal for <strong>stocks and options through Alpaca</strong> plus <strong>perpetual futures through Hyperliquid</strong>. Open <Link href="/app" className="text-primary hover:underline font-medium">/app</Link> to choose a venue, research a market, place an order, review positions, follow traders, or ask the built-in AI assistant for read-only research.
                This tutorial covers the setup paths and the controls that are available today.
              </p>

              <nav aria-label="Mobile guide shortcuts" className="flex flex-wrap gap-2 lg:hidden">
                {MOBILE_SHORTCUTS.map(({ id, label, icon: Icon }) => (
                  <a
                    key={id}
                    href={`#${id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      handleSectionClick(id);
                    }}
                    className="inline-flex min-h-9 items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Icon className="h-4 w-4" />
                    <span>{label}</span>
                  </a>
                ))}
              </nav>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex items-start gap-3 p-3 rounded-lg border">
                  <DollarSign className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Paper & Live Trading</p>
                    <p className="text-xs text-muted-foreground">Practice Alpaca stock/options trades in Paper mode, or switch to Live for real-money Alpaca orders. Hyperliquid perps use the separate Perps wallet.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg border">
                  <Coins className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Hyperliquid Perps</p>
                    <p className="text-xs text-muted-foreground">Set up a self-custody wallet, fund it with native USDC on Arbitrum, and trade perpetual futures from the Perps venue.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg border">
                  <Trophy className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Signals & Copy Trading</p>
                    <p className="text-xs text-muted-foreground">Review X Signals, follow callers or users, and choose between manual Copy and explicitly enabled automatic Mirror.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg border">
                  <MessageCircle className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">AI Chat</p>
                    <p className="text-xs text-muted-foreground">Use platform-provided AI Chat for read-only stock research, account context, filings, news, and reviewed order drafts.</p>
                  </div>
                </div>
              </div>

              <CalloutBox type="info">
                <strong>Estimated setup time:</strong>{" "}5–10 minutes. Follow the steps below in order.
              </CalloutBox>
            </SectionCard>

            {/* ─── STEP 1: CREATE ALPACA ACCOUNT ─── */}
            <SectionCard
              id="create-alpaca"
              title="Step 1 - Create an Alpaca Trading Account"
              icon={UserPlus}
              description="Alpaca is the broker that executes your trades - connect a free paper (simulated) account or a live (real-money) account."
            >
              <div className="space-y-4">
                <InstructionStep step={1}>
                  Go to{" "}
                  <a href="https://alpaca.markets" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1 font-medium">
                    alpaca.markets <ExternalLink className="h-3 w-3" />
                  </a>{" "}
                  and click <strong>"Sign Up"</strong>. A paper (simulated) account works for testing; choose a live brokerage account only when you want to trade real money.
                </InstructionStep>

                <InstructionStep step={2}>
                  Click <strong>Trading Dashboard</strong>, not Documentation or API Reference, then switch to the account you want to connect - <strong>Paper</strong> for test keys or <strong>Live</strong> for real-money keys.
                </InstructionStep>

                <InstructionStep step={3}>
                  Open <strong>Home</strong>, or go directly to{" "}
                  <a href="https://app.alpaca.markets/dashboard/overview" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1 font-medium">
                    app.alpaca.markets/dashboard/overview <ExternalLink className="h-3 w-3" />
                  </a>
                  . Scroll to the bottom-right <strong>API Keys</strong> card.
                </InstructionStep>

                <InstructionStep step={4}>
                  Click <strong>"Generate New Keys"</strong>. You will receive two values:
                  <div className="mt-2 space-y-2">
                    <FieldRow label="API Key ID" value="Copy this into Ready Set Trade's API Key ID field" />
                    <FieldRow label="Secret Key" value="Shown ONLY ONCE - copy and save it immediately!" />
                  </div>
                </InstructionStep>

                <InstructionStep step={5}>
                  Also note your <strong>Account ID</strong>. Go to <strong>Account → Overview</strong> in Alpaca to find it.
                </InstructionStep>
              </div>

              <CalloutBox type="warning">
                <strong>Save your Secret Key</strong>
                <span> somewhere safe (e.g. a password manager or a notes app). Alpaca will never show it again - if you lose it, you'll need to generate a new key pair.</span>
              </CalloutBox>

              <CalloutBox type="info">
                <strong>New to trading?</strong>
                <span> Connect a <strong>Paper</strong> account first - it uses simulated money so you can practice the full Ready Set Trade flow with zero risk, then switch to Live when you're ready.</span>
              </CalloutBox>
            </SectionCard>

            {/* ─── STEP 2: SIGN IN & CONNECT ─── */}
            <SectionCard
              id="sign-in"
              title="Step 2 - Sign In & Connect Your Account"
              icon={LogIn}
              description="Link your Alpaca API keys so Ready Set Trade can execute trades on your behalf."
            >
              <div className="space-y-4">
                <InstructionStep step={1}>
                  On the Ready Set Trade homepage, click the <strong>"Sign in with Google"</strong> button in the top-right corner and sign in with your <strong>Google account</strong>.
                </InstructionStep>

                <InstructionStep step={2}>
                  After signing in, click the{" "}
                  <Settings className="h-3.5 w-3.5 inline" />{" "}
                  <strong>gear icon</strong> in the header to go to the{" "}
                  <Link href="/settings" className="text-primary hover:underline font-medium">Settings page</Link>.
                </InstructionStep>

                <InstructionStep step={3}>
                  On the Settings page, you'll see the <strong>"Add Broker Account"</strong> form. Fill it in:
                  <div className="mt-3 space-y-2">
                    <FieldRow label="Broker" value="Select Alpaca" />
                    <FieldRow label="Account Type" value="Choose Paper Trading (simulated) or Live Trading (real money) - must match the Alpaca account your keys came from" />
                    <FieldRow label="Account ID" value="Your Alpaca account number (from Account → Overview)" />
                    <FieldRow label="API Key ID" value="Paste the API Key ID from Alpaca" />
                    <FieldRow label="Secret Key" value="Paste the Secret Key you saved earlier" />
                  </div>
                </InstructionStep>

                <InstructionStep step={4}>
                  Click <strong>"Save Credentials"</strong>. You should see a <Badge variant="default" className="text-xs bg-green-600">green success message</Badge>.
                </InstructionStep>
              </div>

              <CalloutBox type="success">
                <span>Your API keys are <strong>encrypted</strong> server-side before being stored. They are never visible in plain text.</span>
              </CalloutBox>
            </SectionCard>

            {/* ─── FUND WITH CRYPTO ─── */}
            <SectionCard
              id="fund-crypto"
              title="Fund Your Account with Crypto"
              icon={Coins}
              description="Deposit supported cryptocurrencies directly into your Alpaca account - no bank transfer needed."
            >
              <p className="text-sm text-muted-foreground leading-relaxed">
                This section covers <strong>Alpaca</strong> crypto deposits. In addition to standard bank-wire (ACH) deposits, Alpaca lets you fund your account by sending crypto from an external wallet or exchange. Once the deposit confirms on-chain, the value is credited to your Alpaca account and becomes available buying power for stocks, options, and crypto trades. For Hyperliquid perps, use the separate wallet and deposit flow in the <strong>Trade Hyperliquid Perps</strong> section below.
              </p>

              <div className="space-y-4">
                <InstructionStep step={1}>
                  Sign in to{" "}
                  <a href="https://app.alpaca.markets" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1 font-medium">
                    app.alpaca.markets <ExternalLink className="h-3 w-3" />
                  </a>{" "}
                  and open <strong>Banking → Deposit</strong>. Choose <strong>"Crypto Transfer"</strong> as the deposit method.
                </InstructionStep>

                <InstructionStep step={2}>
                  Select the <strong>asset</strong> you want to deposit (e.g., USDC, BTC, ETH, SOL) and then the <strong>blockchain network</strong> it will arrive on. The asset and network <strong>must match</strong>{" "}what you&apos;re sending - see the supported list below.
                </InstructionStep>

                <InstructionStep step={3}>
                  Alpaca generates a unique <strong>deposit address</strong> for your account. Copy it (or scan the QR code) and paste it into the <strong>"send / withdraw"</strong> screen of your external wallet or exchange. Double-check that the network you select <em>there</em> matches the one Alpaca showed you.
                </InstructionStep>

                <InstructionStep step={4}>
                  Send the crypto. Wait for the on-chain confirmations - usually a few minutes for Solana, longer for Ethereum or Bitcoin. Once confirmed, the deposit shows up in your Alpaca account and you&apos;ll see your <strong>Buying Power</strong> update in Ready Set Trade on the next refresh.
                </InstructionStep>
              </div>

              <CalloutBox type="warning">
                <strong>Always match the network.</strong>
                <span> If you send a token on the wrong blockchain (e.g., USDC on Polygon to an Ethereum address, or BTC to a Bitcoin Cash address), the funds may be <strong>permanently lost</strong>. Verify the asset <em>and</em> the network on both ends before hitting send.</span>
              </CalloutBox>

              <CollapsibleSection title="Supported assets & networks" defaultOpen>
                <p className="text-xs text-muted-foreground">
                  Reference:{" "}
                  <a
                    href="https://alpaca.markets/support/what-assets-and-blockchains-do-you-support-for-crypto-deposits"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Alpaca support docs <ExternalLink className="h-3 w-3" />
                  </a>
                </p>

                <div>
                  <p className="text-sm font-medium mb-2">Stablecoins</p>
                  <div className="grid gap-1.5 text-sm">
                    <div className="p-2 rounded bg-muted/50 flex justify-between gap-2">
                      <span><strong>USDG</strong> - Global Dollar</span>
                      <span className="text-xs text-muted-foreground">Ethereum · Solana</span>
                    </div>
                    <div className="p-2 rounded bg-muted/50 flex justify-between gap-2">
                      <span><strong>USDC</strong> - USD Circle</span>
                      <span className="text-xs text-muted-foreground">Ethereum · Solana</span>
                    </div>
                    <div className="p-2 rounded bg-muted/50 flex justify-between gap-2">
                      <span><strong>USDT</strong> - Tether</span>
                      <span className="text-xs text-muted-foreground">Ethereum · Solana</span>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-medium mb-2">Other cryptocurrencies</p>
                  <div className="grid gap-1.5 text-sm">
                    <div className="p-2 rounded bg-muted/50 flex justify-between gap-2">
                      <span><strong>BTC</strong> - Bitcoin</span>
                      <span className="text-xs text-muted-foreground">Bitcoin</span>
                    </div>
                    <div className="p-2 rounded bg-muted/50 flex justify-between gap-2">
                      <span><strong>BCH</strong> - Bitcoin Cash</span>
                      <span className="text-xs text-muted-foreground">Bitcoin Cash</span>
                    </div>
                    <div className="p-2 rounded bg-muted/50 flex justify-between gap-2">
                      <span><strong>ETH</strong> - Ethereum</span>
                      <span className="text-xs text-muted-foreground">Ethereum</span>
                    </div>
                    <div className="p-2 rounded bg-muted/50 flex justify-between gap-2">
                      <span><strong>SOL</strong> - Solana</span>
                      <span className="text-xs text-muted-foreground">Solana</span>
                    </div>
                    <div className="p-2 rounded bg-muted/50 flex justify-between gap-2">
                      <span><strong>AAVE</strong> · <strong>BAT</strong> · <strong>CRV</strong> · <strong>GRT</strong> · <strong>SHIB</strong> · <strong>SKY</strong> · <strong>SUSHI</strong> · <strong>UNI</strong> · <strong>YFI</strong></span>
                      <span className="text-xs text-muted-foreground shrink-0 ml-2">Ethereum only</span>
                    </div>
                  </div>
                </div>
              </CollapsibleSection>

              <CalloutBox type="info">
                <strong>Paper accounts can&apos;t receive real crypto.</strong>
                <span> Crypto deposits go to your <strong>Live</strong> Alpaca account only. For practice, stay in Paper mode - your simulated cash balance is already credited.</span>
              </CalloutBox>

              <CalloutBox type="tip">
                <strong>Test with a small amount first.</strong>
                <span> Especially for a new address or a network you haven&apos;t used before, send a small test transfer, confirm it lands in Alpaca, then send the rest.</span>
              </CalloutBox>
            </SectionCard>

            {/* ─── DASHBOARD LAYOUT ─── */}
            <SectionCard
              id="dashboard"
              title="Step 3 - Understanding the Dashboard"
              icon={LayoutDashboard}
              description="Get familiar with the terminal panes, venue switch, and the controls available on /app."
            >
              <p className="text-sm text-muted-foreground">
                On desktop, <Link href="/app" className="text-primary hover:underline font-medium">/app</Link> is organized into three panes (or stacked on mobile). When perps are enabled, the header venue switch lets you choose <strong>Stocks</strong> or <strong>Perps</strong>; the right-side account and positions view follows that venue.
              </p>

              <div className="space-y-3">
                <div className="p-4 rounded-lg border-l-4 border-blue-500 bg-blue-500/5">
                  <p className="font-medium text-sm flex items-center gap-2">
                    <Zap className="h-4 w-4 text-blue-500" />
                    Left Column - X Signals
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Shows recent trade signals from X and stored signal sources. Each card shows the stock symbol, the message, the source/poster, and how long ago it posted. <strong>Click any signal</strong> to auto-fill the New Trade form with that symbol. Use the <strong>X Signals / Watchlist</strong> toggle at the top to switch to your watchlist, and scroll down to the <strong>Community Trades</strong> feed to see what other members are trading.
                  </p>
                </div>

                <div className="p-4 rounded-lg border-l-4 border-primary bg-primary/5">
                  <p className="font-medium text-sm flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    Middle Column - New Trade / AI Chat
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    This column has two tabs:{" "}
                    <strong>"New Trade"</strong> (to place orders - exit plans are set up inline via the OCO order type) and{" "}
                    <strong>"AI Chat"</strong> (to ask the built-in AI assistant about a stock or your account).
                    When you type a stock symbol on the New Trade tab, a live TradingView chart and the current price appear automatically.
                  </p>
                </div>

                <div className="p-4 rounded-lg border-l-4 border-green-500 bg-green-500/5">
                  <p className="font-medium text-sm flex items-center gap-2">
                    <Layers className="h-4 w-4 text-green-500" />
                    Right Column - Account & Positions
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Shows your <strong>account summary</strong> (portfolio value, buying power, and cash), your <strong>open positions</strong> with real-time P&L (toggle <strong>Open / Closed</strong> to review trade history), and a separate <strong>Open Orders</strong> panel listing pending orders. On each position you can edit the stop loss inline (pencil icon) or open the <strong>Close Position</strong> dialog to close part or all of it as a market or limit order.
                  </p>
                </div>
              </div>
            </SectionCard>

            {/* ─── HYPERLIQUID PERPS ─── */}
            <SectionCard
              id="perps"
              title="Trade Perpetual Futures on Hyperliquid"
              icon={Coins}
              description="Set up your self-custody wallet, fund it with native USDC (Arbitrum) or native SOL (Solana via Unit), and trade perps directly in the terminal."
            >
              <p className="text-sm text-muted-foreground leading-relaxed">
                Hyperliquid perps run on a self-custody embedded wallet with a policy-locked server trading agent so orders stay popup-free. Open <Link href="/settings?t=perps" className="text-primary hover:underline font-medium">Settings → Perps</Link> or switch to the <strong>Perps</strong> venue in <Link href="/app" className="text-primary hover:underline font-medium">/app</Link> to complete setup.
              </p>

              <div className="space-y-4">
                <InstructionStep step={1}>
                  Sign in with Google (or email). Open <Link href="/settings?t=perps" className="text-primary hover:underline font-medium">Settings → Perps</Link> and click <strong>Create new wallet</strong> (created automatically on first setup) or choose <strong>Import existing wallet</strong> to bring your own private key into Privy&apos;s secure enclave. Your private key is sealed in the enclave and never sent to our servers.
                </InstructionStep>

                <InstructionStep step={2}>
                  Click <strong>Enable Perps</strong> (or let automatic setup run). This provisions a dedicated server trading agent that signs orders on your behalf. The agent has execution permissions only—it can <strong>never withdraw</strong> your funds.
                </InstructionStep>

                <InstructionStep step={3}>
                  <span>Choose your funding method under <strong>How to fund your account</strong>:</span>
                  <ul className="mt-2 ml-4 list-disc text-xs text-muted-foreground space-y-1.5">
                    <li>
                      <strong>Arbitrum (Native USDC):</strong> Copy your wallet address and send <strong>native Circle USDC on Arbitrum only</strong> directly from any wallet or exchange. Once it arrives, enter the amount and click <strong>Deposit USDC</strong>. (No Arbitrum ETH gas is required).
                    </li>
                    <li>
                      <strong>Solana (Native SOL via Unit):</strong> Select the Solana tab to view your dedicated Unit deposit address. Send native SOL from Phantom, Solflare, or an exchange; Unit automatically bridges it to your Hyperliquid balance without needing Arbitrum ETH.
                    </li>
                  </ul>
                </InstructionStep>

                <InstructionStep step={4}>
                  <span><strong>Deposit Confirmation:</strong> Once your deposit confirms on-chain (automatically bridged via Unit for Solana SOL, or via the <strong>Deposit USDC</strong> button for Arbitrum), your Hyperliquid trading balance updates and the trading agent activates automatically.</span>
                </InstructionStep>

                <InstructionStep step={5}>
                  Once your status shows <Badge variant="default" className="text-xs bg-green-600">Active</Badge>, switch to <strong>Perps</strong> in the trading terminal on <Link href="/app" className="text-primary hover:underline font-medium">/app</Link>. Select your target coin (e.g., BTC, ETH, SOL, DOGE), choose <strong>Long or Short</strong>, set your margin mode and leverage, enter your size, and submit orders popup-free.
                </InstructionStep>
              </div>

              <CalloutBox type="info">
                <strong>Zero-Popup Trading:</strong>
                <span> Once your trading agent is activated and funded, placing, editing, or closing perp positions requires no manual Web3 wallet popup approvals.</span>
              </CalloutBox>

              <CalloutBox type="warning">
                <strong>Leverage & Risk:</strong>
                <span> Perpetual futures use leverage. Always double-check your position size, liquidation price, margin mode, and leverage before opening a position.</span>
              </CalloutBox>
            </SectionCard>

            {/* ─── MARKET ORDER ─── */}
            <SectionCard
              id="market-order"
              title="Step 4 - Place a Market Order (Stocks)"
              icon={TrendingUp}
              description="Buy or sell a stock immediately at the current market price."
            >
              <p className="text-sm text-muted-foreground">
                A <strong>Market order</strong> is the simplest order type - it executes immediately at the best available price. Here's how to place one:
              </p>

              <div className="space-y-4">
                <InstructionStep step={1}>
                  Go to the <Link href="/app" className="text-primary hover:underline font-medium">Dashboard</Link> and find the <strong>"New Trade"</strong> tab in the middle column.
                </InstructionStep>

                <InstructionStep step={2}>
                  In the <strong>Symbol</strong> field, type a ticker like <Badge variant="outline">AAPL</Badge> or <Badge variant="outline">TSLA</Badge>.
                  A live chart and price badge will appear (e.g., <Badge variant="default" className="text-xs">$227.50</Badge>).
                </InstructionStep>

                <InstructionStep step={3}>
                  Set the form fields:
                  <div className="mt-2 space-y-1.5">
                    <FieldRow label="Asset Type" value='Equity (Stock)' />
                    <FieldRow label="Order Type" value='Market' />
                    <FieldRow label="Time in Force" value='GTC (Good Till Cancelled) - default' />
                  </div>
                </InstructionStep>

                <InstructionStep step={4}>
                  Under <strong>Action</strong> and <strong>Direction</strong>:
                  <div className="mt-2 space-y-1.5">
                    <FieldRow label="Action" value='"Buy" to purchase shares' />
                    <FieldRow label="Direction" value='"Long" to go long (profit from price going up)' />
                  </div>
                </InstructionStep>

                <InstructionStep step={5}>
                  Enter a <strong>Quantity</strong> (e.g., <strong>1</strong> share).
                </InstructionStep>

                <InstructionStep step={6}>
                  Click <strong>"Submit Order"</strong>. A success message will appear and the order will show in your Positions panel.
                </InstructionStep>
              </div>

              <CalloutBox type="tip">
                <strong>Risk Calculator:</strong>
                <span> Fill in the <strong>Max $ Risk</strong> and <strong>Stop Loss Price</strong> fields and Ready Set Trade computes a suggested share count (Max $ Risk ÷ distance to your stop). A <strong>"Size to $ risk → N"</strong> button appears above the Quantity field - click it to apply the suggested quantity.</span>
              </CalloutBox>
            </SectionCard>

            {/* ─── LIMIT ORDER ─── */}
            <SectionCard
              id="limit-order"
              title="Step 5 - Place a Limit Order"
              icon={ArrowUpDown}
              description="Buy or sell only when the stock hits a specific price you choose."
            >
              <p className="text-sm text-muted-foreground">
                A <strong>Limit order</strong> only executes at the exact price you set (or better). Use this when you want to buy at a price <em>lower</em> than the current market, or sell at a price <em>higher</em>.
              </p>

              <div className="space-y-4">
                <InstructionStep step={1}>
                  Type your stock symbol (e.g., <Badge variant="outline">AAPL</Badge>).
                </InstructionStep>

                <InstructionStep step={2}>
                  Change <strong>Order Type</strong> to <strong>"Limit"</strong>.
                </InstructionStep>

                <InstructionStep step={3}>
                  A new <strong>Limit Price</strong> field will appear. Enter the price you want to buy/sell at (e.g., if AAPL is $230, you might set a buy limit at $225).
                </InstructionStep>

                <InstructionStep step={4}>
                  Set Action to <strong>Buy</strong>, Direction to <strong>Long</strong>, and Quantity to <strong>1</strong>.
                </InstructionStep>

                <InstructionStep step={5}>
                  Click <strong>"Submit Order"</strong>. The order will remain pending until the stock price reaches your limit price.
                </InstructionStep>
              </div>

              <CollapsibleSection title="Other Order Types: Stop Market & Stop Limit">
                <p className="text-sm text-muted-foreground">
                  Ready Set Trade also supports:
                </p>
                <div className="space-y-2 text-sm">
                  <div className="pl-2 border-l-2 border-muted-foreground/30">
                    <strong>Stop Market</strong> - triggers a market order when the price hits your stop. Use it to limit losses (sell if price drops to a certain level).
                    <br />
                    <span className="text-xs text-muted-foreground">Select "Stop Market" → fill in the "Price Trigger (Stop)" field.</span>
                  </div>
                  <div className="pl-2 border-l-2 border-muted-foreground/30">
                    <strong>Stop Limit</strong> - triggers a limit order when the price hits your stop. More precise but may not fill if the stock moves too fast.
                    <br />
                    <span className="text-xs text-muted-foreground">Select "Stop Limit" → fill in both the "Price Trigger (Stop)" and "Limit Price" fields.</span>
                  </div>
                </div>
              </CollapsibleSection>
            </SectionCard>

            {/* ─── OCO / BRACKET ORDER ─── */}
            <SectionCard
              id="oco-order"
              title="Step 6 - The One-Click Exit Plan (Smart Exit)"
              icon={Target}
              description="Equities default to an auto-filled exit plan: a protective stop, a take-profit, and a trailing stop that rides the rest up. Review and submit."
            >
              {/* Scoped suppressHydrationWarning: React 19 SSR text node whitespace
                  collapsing after inline <em> tags causes 1-space diffs in dev mode. */}
              <p className="text-sm text-muted-foreground" suppressHydrationWarning>
                For stocks, the <strong>"Buy + Auto-Exits - TP + Stop (OCO)"</strong> order type is selected by default and the <strong>Exit plan</strong> card auto-fills itself. The goal: <em>click a signal (or type a symbol), glance at the plan, and hit Submit.</em><span> You don&apos;t have to babysit the chart - the exits attach to the position on their own.</span>
              </p>

              <p className="text-sm text-muted-foreground">
                What the plan does by default once you pick a symbol with a live quote:
              </p>
              <ul className="ml-4 list-disc text-sm text-muted-foreground space-y-1">
                <li><strong className="text-red-500">Stop Loss</strong> is set to the <strong>Low of Day</strong> (for a long) or <strong>High of Day</strong> (for a short).</li>
                <li><strong>Max $ Risk</strong> is restored to the last amount you used, and your <strong>share Quantity</strong> is sized automatically from it.</li>
                <li>A fixed <strong className="text-green-500">take-profit at 0.4R</strong> banks <strong>half</strong> the position.</li>
                <li>A <strong className="text-blue-500">trailing stop</strong> rides the other half up (trail distance ≈ your 1R risk as a percent of entry), selling only if price falls back by that amount.</li>
              </ul>

              <div className="space-y-4">
                <InstructionStep step={1}>
                  Type a stock symbol (e.g., <Badge variant="outline">AAPL</Badge>) or click a signal. The <strong>Exit plan</strong> card fills in Entry, Stop, Quantity, the 0.4R take-profit, and the trailing runner.
                </InstructionStep>

                <InstructionStep step={2}>
                  Review the numbers. Adjust anything you like - tap <span className="text-blue-500 font-medium">"Sync Mkt"</span> or the <span className="text-blue-500 font-medium">"LOD/HOD"</span> shortcut, edit the take-profit rows, change the <strong>Trail %</strong> or <strong>Runner Qty</strong>, or hit <strong>"Auto-fill plan"</strong> to re-seed everything.
                </InstructionStep>

                <InstructionStep step={3}>
                  Need a different mix? Use the <strong>+0.4R / +0.7R / +1R / +2R</strong> buttons to add fixed take-profit levels, or check <strong>"Trail the whole position (skip the fixed take-profit)"</strong> under Advanced Options to let the entire position ride the trailing stop.
                </InstructionStep>

                <InstructionStep step={4}>
                  Click <strong>"Submit Order"</strong>. Your entry is placed immediately. Because a trailing stop can only sit against shares you already hold, the take-profit and trailing stop <strong>attach automatically once the entry fills</strong> (usually within a few seconds for a market order). You&apos;ll see them appear in <strong>Open Orders</strong>.
                </InstructionStep>
              </div>

              <CollapsibleSection title="Example: Smart Exit on 20 shares of AAPL @ $230" defaultOpen>
                <div className="space-y-2 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <FieldRow label="Symbol" value="AAPL" />
                    <FieldRow label="Entry Price" value="$230.00" />
                    <FieldRow label="Stop Loss (LOD)" value="$226.00" />
                    <FieldRow label="Max $ Risk → Qty" value="$80 → 20 shares" />
                    <FieldRow label="Take-profit (0.4R)" value="$231.60 × 10 shares" />
                    <FieldRow label="Trailing runner" value="10 shares · ~1.74% trail" />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    1R = $230 − $226 = <strong>$4</strong>/share. 0.4R take-profit = $230 + $1.60 = <strong>$231.60</strong> on 10 shares (an OCO, so it keeps the $226 stop until it fills). The other 10 shares trail by ~1R as a percent of entry ($4 / $230 ≈ <strong>1.74%</strong>), locking in more as price climbs and exiting on a pullback.
                  </p>
                </div>
              </CollapsibleSection>
            </SectionCard>

            {/* ─── LIVE SIGNALS ─── */}
            <SectionCard
              id="signals"
              title="Step 7 - Use Signals"
              icon={Zap}
              description="Review X Signals and use an eligible signal to prefill the stock trade form."
            >
              <div className="space-y-4">
                <InstructionStep step={1}>
                  Look at the <strong>"X Signals"</strong> feed on the <strong>left side</strong> of the dashboard (next to <strong>"Watchlist"</strong>). This shows recent trade signals parsed from X (Twitter) posts and any signals stored in the app.
                </InstructionStep>

                <InstructionStep step={2}>
                  Each signal card shows:
                  <ul className="mt-1 ml-4 list-disc text-xs text-muted-foreground space-y-1">
                    <li>The <strong>stock symbol</strong> (e.g., $AAPL)</li>
                    <li>The <strong>signal message</strong> from the post</li>
                    <li>The source it came from (e.g. the X account) and when it posted</li>
                    <li>A "View Original" link (when available) that opens the original post in a new tab</li>
                  </ul>
                </InstructionStep>

                <InstructionStep step={3}>
                  <strong>Click on any signal</strong> - it will <em>auto-populate</em> the trade form's Symbol field with the stock ticker. The signal card will become highlighted with a blue ring.
                </InstructionStep>

                <InstructionStep step={4}>
                  Review the signal details, then choose your order type and settings as described above. Submit the order when ready.
                </InstructionStep>
              </div>

              <CalloutBox type="info">
                <span>Signals are refreshed every <strong>10 seconds</strong> automatically. The feed shows the most recent 50 signals.</span>
              </CalloutBox>
            </SectionCard>

            {/* ─── MANAGE POSITIONS ─── */}
            <SectionCard
              id="positions"
              title="Step 8 - Manage Your Positions"
              icon={Layers}
              description="Monitor, inspect, and close your open positions."
            >
              <div className="space-y-4">
                <InstructionStep step={1}>
                  The <strong>Account Summary</strong> card on the right shows your portfolio overview:
                  <ul className="mt-1 ml-4 list-disc text-xs text-muted-foreground space-y-1">
                    <li><strong>Portfolio Value</strong> - total value of all holdings + cash</li>
                    <li><strong>Buying Power</strong> - how much you can still invest</li>
                    <li><strong>Cash</strong> - uninvested cash balance</li>
                  </ul>
                  The card header shows whether you're viewing your <strong>Paper</strong> or <strong>Live</strong> account, and the account number (e.g. "Live #1234…") links to your Alpaca dashboard.
                </InstructionStep>

                <InstructionStep step={2}>
                  Below the account summary, the <strong>"Open Positions"</strong> card lists everything you own. Each position shows:
                  <ul className="mt-1 ml-4 list-disc text-xs text-muted-foreground space-y-1">
                    <li>Symbol, side (LONG/SHORT), and number of shares/contracts</li>
                    <li>Entry price and current market value</li>
                    <li>Unrealized P&L (profit/loss) with color coding: <span className="text-green-500">green = profit</span>, <span className="text-red-500">red = loss</span></li>
                  </ul>
                </InstructionStep>

                <InstructionStep step={3}>
                  <strong>Click on a position</strong> to expand it and see more details: current price, cost basis, today's change %, and any attached <strong>exit orders</strong> (stop losses, take profits, trailing stops). You can adjust an existing stop loss without closing the position - click the <strong>pencil</strong> icon next to a Stop Loss order, enter a new price, and click the check mark to save.
                </InstructionStep>

                <InstructionStep step={4}>
                  To close a position, click the red <strong>"Close Position"</strong> button in the expanded view. A close dialog appears where you choose <strong>how many</strong> shares/contracts to sell and whether to close at <strong>Market</strong> (immediate) or <strong>Limit</strong> (at a price you set), then click <strong>"Confirm Close"</strong>. Fractional positions can only be closed in full at market.
                </InstructionStep>

                <InstructionStep step={5}>
                  Use the <strong>Open | Closed</strong> toggle at the top of the positions card to switch between your current open positions and a <strong>history</strong> of recently closed/filled orders (side, symbol, quantity, fill price, and status).
                </InstructionStep>

                <InstructionStep step={6}>
                  Click <strong>"Refresh"</strong> to force an immediate update of your positions and account data. (Positions auto-refresh every 30 seconds; the account summary every 60 seconds.)
                </InstructionStep>
              </div>
            </SectionCard>

            {/* ─── COPY TRADING ─── */}
            <SectionCard
              id="copy-trading"
              title="Follow & Copy Traders"
              icon={Trophy}
              description="Discover callers and users, then choose a review-first Copy flow or explicitly enabled Mirror automation."
            >
              <p className="text-sm text-muted-foreground leading-relaxed">
                Open <Link href="/lb" className="text-primary hover:underline font-medium">Top Traders</Link> to vet the <strong>Callers</strong> ranking or switch to <Link href="/lb?t=users" className="text-primary hover:underline font-medium">Users</Link>. In <Link href="/app" className="text-primary hover:underline font-medium">/app</Link>, the <strong>Copy Trade</strong> panel has <strong>All</strong>, <strong>Following</strong>, <strong>Callers</strong>, and <strong>Users</strong> sources, plus <strong>How it works</strong>, <strong>Top Traders</strong>, and <strong>Manage follows</strong> controls.
              </p>

              <div className="space-y-4">
                <InstructionStep step={1}>
                  Use <strong>Follow</strong> to add a trader or caller to your Following feed. Following does not place an order; it only keeps that source easy to review.
                </InstructionStep>

                <InstructionStep step={2}>
                  Use <strong>Copy</strong> for a review-first workflow. The app prefills the appropriate trade ticket for eligible stock, option, or Hyperliquid perp activity, but you must inspect the form and submit it yourself. A copied perp stays on Hyperliquid; it is not converted into an Alpaca equity order.
                </InstructionStep>

                <InstructionStep step={3}>
                  Use <strong>Mirror</strong> only after the confirmation step and only when the follow is explicitly enabled for automatic copying. Open <strong>Manage follows</strong> to review the saved destination, sizing, limits, and any per-follow settings. Stopping a mirror does not close an existing position.
                </InstructionStep>
              </div>

              <CalloutBox type="info">
                <strong>Destinations are saved per follow.</strong>
                <span> Stocks and options use the connected Alpaca account; Hyperliquid perps require the separate wallet setup and funding described above. The terminal&apos;s Paper/Live toggle does not change a follow&apos;s saved destination.</span>
              </CalloutBox>

              <CalloutBox type="warning">
                <strong>Review automatic perps carefully.</strong>
                <span> In <Link href="/settings?t=copy-trading" className="text-current underline font-medium">Settings → Copy Trading</Link>, set the global maximum leverage before enabling mirror follows. Perp mirror settings may also include a follow-level leverage cap and optional TP/SL percentages; order, duplicate, sizing, and existing-holding limits can skip or cap a mirror. Activity is not a guarantee of fills or performance.</span>
              </CalloutBox>
            </SectionCard>

            {/* ─── AI CHAT ─── */}
            <SectionCard
              id="ai-chat"
              title="Use AI Chat"
              icon={MessageCircle}
              description="Ask the platform-provided assistant for read-only stock research and reviewed order drafts."
            >
              <p className="text-sm text-muted-foreground leading-relaxed">
                In <Link href="/app" className="text-primary hover:underline font-medium">/app</Link>, switch the middle pane from <strong>New Trade</strong> to <strong>AI Chat</strong>. AI Chat is currently for <strong>read-only stock research</strong> using available portfolio, filings, and news context; it is not a perps trading assistant.
              </p>

              <div className="space-y-4">
                <InstructionStep step={1}>
                  Sign in and connect the trading credentials needed by the terminal. If the panel says <strong>Set your trading credentials in Settings to use AI Chat</strong>, open <Link href="/settings" className="text-primary hover:underline font-medium">Settings</Link> and finish the broker setup first.
                </InstructionStep>

                <InstructionStep step={2}>
                  Ask about a stock, your account context, filings, or recent news. Use the suggested prompts when you are getting started; saved chats, <strong>New chat</strong>, and <strong>Clear chat</strong> are available in the panel.
                </InstructionStep>

                <InstructionStep step={3}>
                  You can ask AI Chat to draft an order, including the <strong><code>/draft $SYM</code></strong> command. A draft only prefills the trade ticket so you can review it; AI Chat never submits an order automatically.
                </InstructionStep>

                <InstructionStep step={4}>
                  The model is provided by the platform - no separate API key is required. To review the AI Models status, open <Link href="/settings?t=models" className="text-primary hover:underline font-medium">Settings → AI Models</Link>. If the panel says it is not configured yet, contact support rather than entering a key in the chat.
                </InstructionStep>
              </div>

              <CalloutBox type="warning">
                <strong>Keep the final decision yours.</strong>
                <span> Read-only research can be incomplete or wrong. Confirm the symbol, side, quantity, price, account, and venue in the trade ticket before submitting anything.</span>
              </CalloutBox>
            </SectionCard>

            {/* ─── EXIT STRATEGIES ─── */}
            <SectionCard
              id="exit-strategy"
              title="Step 9 - Set Up Auto-Exits (OCO)"
              icon={SplitSquareHorizontal}
              description="Attach a stop loss and multiple take-profit levels to your entry using the OCO order type."
            >
              <p className="text-sm text-muted-foreground">
                Exit orders are set up <strong>inline on the New Trade form</strong> - there's no separate tab. For stocks the <strong>"Exit plan"</strong> card is shown and auto-filled by default (see Step 6). It sets a stop, a 0.4R take-profit on half the position, and a trailing stop on the rest. You can edit any of it before submitting.
              </p>

              <div className="space-y-4">
                <InstructionStep step={1}>
                  Enter the <strong>Symbol</strong> you want to trade (e.g., <Badge variant="outline">AAPL</Badge>), or click a signal. The exit plan auto-fills and is attached to the order you place.
                </InstructionStep>

                <InstructionStep step={2}>
                  Review the <strong className="text-red-500">Stop Loss</strong> (defaults to Low/High of Day) - the price that caps your loss. The <strong>Take-profit</strong> rows and the <strong className="text-blue-500">trailing runner</strong> are pre-sized; tweak prices, quantities, or the <strong>Trail %</strong> as you like.
                </InstructionStep>

                <InstructionStep step={3}>
                  Want only fixed take-profits and no runner? Uncheck <strong>"Trailing stop on the runner"</strong>. Want the whole position to trail? Check <strong>"Trail the whole position (skip the fixed take-profit)"</strong> under Advanced Options.
                </InstructionStep>

                <InstructionStep step={4}>
                  Click <strong>"Submit Order"</strong>. Your entry is placed now; the take-profit (as an OCO that keeps the stop) and the trailing stop <strong>attach to the position automatically once the entry fills</strong>. If you turn the trailing runner off, the app instead submits one linked bracket/OCO order per take-profit level.
                </InstructionStep>
              </div>

              <CollapsibleSection title="Example: Exit plan for 20 shares of AAPL @ $230" defaultOpen>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="w-14 justify-center">TP</Badge>
                    <span>Sell 10 shares at $231.60 <span className="text-green-500">(+0.4R)</span> - OCO with the $226 stop</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="w-14 justify-center bg-blue-600">Trail</Badge>
                    <span>10 shares ride a ~1.74% trailing stop, locking in more as price rises</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="w-14 justify-center bg-red-600">Stop</Badge>
                    <span>The take-profit half keeps a hard $226 stop until it fills</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Risk per share = $230 − $226 = <strong>$4</strong> (1R). The 0.4R take-profit at $231.60 banks half; the rest trails by ~1R as a percent of entry. Both legs attach after the entry fills - until then they wait, because a trailing sell needs shares to sit against.
                  </p>
                </div>
              </CollapsibleSection>
            </SectionCard>

            {/* ─── TIPS & NOTES ─── */}
            <SectionCard
              id="tips"
              title="Tips & Important Notes"
              icon={Info}
              description="Key things to know before you start trading."
            >
              <div className="space-y-3">
                <CalloutBox type="warning">
                  <strong>Market Hours:</strong>
                  <span> Regular-hours orders fill during US market hours: <strong>9:30 AM – 4:00 PM Eastern Time</strong>, Monday through Friday. Orders placed outside these hours may be queued or rejected depending on the order settings and Alpaca account permissions.</span>
                </CalloutBox>

                <CalloutBox type="info">
                  <strong>Paper vs Live:</strong>
                  <span> For Alpaca stocks and options, use the Paper/Live toggle in the top bar to choose your account. Paper mode trades with simulated money; Live mode connects to your real Alpaca account and submitted orders use real money. Hyperliquid perps have a separate wallet and do not use this toggle. New users default to Paper.</span>
                </CalloutBox>

                <CalloutBox type="success">
                  <strong>Security:</strong>
                  <span> All API keys are encrypted server-side using AES-256 before storage. Your credentials are never saved or displayed in plain text.</span>
                </CalloutBox>

              </div>

              <Separator />

              <div className="space-y-3">
                <h4 className="font-medium text-sm">Helpful Trading Terms</h4>
                <p className="text-xs text-muted-foreground">Quick definitions - see the <strong>Glossary</strong> section below for the full list.</p>
                <div className="grid gap-2 text-sm">
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Market Order</strong> - Executes instantly at the current price. No price guarantee.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Limit Order</strong> - Only executes at your specified price or better.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Stop Loss (SL)</strong> - An exit order that sells if the price drops to protect against bigger losses.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Take Profit (TP)</strong> - An exit order that sells when the price rises to lock in gains.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>OCO / Bracket</strong> - A combination of TP + SL that automatically cancels one when the other fills.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Trailing Stop</strong> - A stop that follows price movement. Locks in profits as the stock rises.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>GTC</strong> - Good Till Cancelled. The order stays active until it fills or you cancel it.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>R-Multiple</strong> - Risk unit. 1R = distance between entry and stop loss. Used to measure reward vs. risk.
                  </div>
                </div>
              </div>
            </SectionCard>

            {/* ─── GLOSSARY ─── */}
            <SectionCard
              id="glossary"
              title="Glossary"
              icon={BookOpen}
              description="Plain-English definitions of the trading terms used throughout this app. New to trading? Start here."
            >
              <p className="text-sm text-muted-foreground">
                Tap a group to expand it. Every term is explained in plain language, with a quick example where it helps.
              </p>

              <CalloutBox type="tip">
                <strong>The fastest path:</strong>
                <span> a <strong>Bracket (OCO)</strong> order buys a stock and attaches a <span className="text-green-500 font-medium">Take Profit</span> and a <span className="text-red-500 font-medium">Stop Loss</span> for you. If you only learn a few terms, learn those three.</span>
              </CalloutBox>

              {/* ── Order Types ── */}
              <CollapsibleSection title="Order Types - how you buy and sell" defaultOpen>
                <div className="grid gap-2 text-sm">
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Market order</strong> - Buys or sells right now at the best available price. Fast, but no price guarantee.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Limit order</strong> - Only fills at the price you set or better. Example: a buy limit at $225 won't fill until the stock reaches $225 or lower.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Stop Market</strong> - Becomes a market order once the price hits a trigger you choose. Often used to sell automatically if a stock falls to a set level.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Stop Limit</strong> - Like Stop Market, but turns into a limit order at the trigger. More price control, but it may not fill if price moves too fast.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Bracket order</strong> - A buy with a Take Profit and Stop Loss attached automatically. In this app it's the "Buy + Auto-Exits (OCO)" option.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>OCO (One-Cancels-Other)</strong> - Two linked exits where filling one cancels the other. This app builds one OCO bracket for each take-profit level you add.
                  </div>
                </div>
              </CollapsibleSection>

              {/* ── Venues, Copy Trading & AI ── */}
              <CollapsibleSection title="Venues, Copy Trading & AI">
                <div className="grid gap-2 text-sm">
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Perps / perpetual futures</strong> - A leveraged futures position with no fixed expiration. In this app, perps are traded on Hyperliquid through the separate self-custody wallet and the <strong>Perps</strong> venue.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Follow</strong> - Adds a caller or user to your Following feed. It does not place orders.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Copy</strong> - Prefills an eligible trade ticket for your review. You still submit the order yourself.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Mirror</strong> - Explicitly enabled automatic copying for an eligible follow, subject to the configured sizing, leverage, duplicate, and existing-holding limits. Stopping a mirror does not exit a position.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>AI Chat</strong> - The platform-provided, read-only stock research assistant. An order draft can prefill the trade ticket, but the assistant never submits it automatically.
                  </div>
                </div>
              </CollapsibleSection>

              {/* ── Exits & Risk ── */}
              <CollapsibleSection title="Exits & Risk - protecting and sizing a trade">
                <div className="grid gap-2 text-sm">
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Stop Loss (SL)</strong> - An exit that sells if the price drops to a level you pick, so a losing trade can't keep getting worse.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Take Profit (TP)</strong> - An exit that sells when the price rises to a level you pick, locking in the gain. You can set several to sell in pieces.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Trailing stop</strong> - A stop that moves up as price rises but never back down. Example: a 2% trailing stop sells if price falls 2% from its high.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Entry price</strong> - The price you get into a trade at. This app uses it to calculate R-based take-profits. Click <span className="text-blue-500 font-medium">"Sync Mkt"</span> to fill it with the live price.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>R / R-multiple</strong> - R is your risk per share: the distance from entry to stop loss. +1R aims to make what you'd lose at the stop (1:1); +2R aims for double. Example: entry $230, stop $226 → 1R = $4, so +1R = $234.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Max Risk ($)</strong> - The most you're willing to lose if your stop is hit. The app suggests a quantity from it: roughly Max Risk ÷ the distance from price to your stop.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Quantity</strong> - How much you're trading: shares for stocks, contracts for options.
                  </div>
                </div>
              </CollapsibleSection>

              {/* ── Direction ── */}
              <CollapsibleSection title="Direction - which way you're betting">
                <div className="grid gap-2 text-sm">
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Long</strong> - Betting the price goes <span className="text-green-500 font-medium">up</span>. You buy first and profit if it rises.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Short</strong> - Betting the price goes <span className="text-red-500 font-medium">down</span>. You sell borrowed shares first and profit if it falls, buying back lower to close.
                  </div>
                </div>
              </CollapsibleSection>

              {/* ── Time in Force ── */}
              <CollapsibleSection title="Time in Force - how long an order stays open">
                <div className="grid gap-2 text-sm">
                  <div className="p-2 rounded bg-muted/50">
                    <strong>GTC (Good Till Cancelled)</strong> - Stays open across days until it fills or you cancel it. The default for stock orders here.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Day</strong> - Active only for today; cancelled at market close if unfilled. Options orders here use Day except limit sells, which use GTC.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>IOC (Immediate or Cancel)</strong> - Fill what's available instantly, cancel the rest. Partial fills allowed.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>FOK (Fill or Kill)</strong> - Fill the entire order at once or cancel it all. No partial fills.
                  </div>
                </div>
              </CollapsibleSection>

              {/* ── Account ── */}
              <CollapsibleSection title="Account - what the numbers mean">
                <div className="grid gap-2 text-sm">
                  {ACCOUNT_GLOSSARY_TERMS.map(({ term, definition }) => (
                    <div key={term} className="p-2 rounded bg-muted/50">
                      <strong>{term}</strong> - {definition}
                    </div>
                  ))}
                </div>
              </CollapsibleSection>

              {/* ── Options ── */}
              <CollapsibleSection title="Options - for trading calls & puts">
                <div className="grid gap-2 text-sm">
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Option</strong> - A contract giving you the right (not obligation) to buy or sell a stock at a set price before a set date. Cheaper than the stock, but can expire worthless.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Call</strong> - An option that profits when the stock goes <span className="text-green-500 font-medium">up</span>. The right to buy at the strike price.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Put</strong> - An option that profits when the stock goes <span className="text-red-500 font-medium">down</span>. The right to sell at the strike price.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Contract</strong> - One unit of an option, usually covering 100 shares - so cost and risk are multiplied by 100.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Strike (strike price)</strong> - The fixed price the option lets you buy (call) or sell (put) at. You pick it from a dropdown here.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Expiration</strong> - The date the option stops being valid. After it, the option is worth its in-the-money value or nothing.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Premium</strong> - The price you pay to buy an option (or collect to sell one). Shown here as Last and Bid/Ask.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>In / Out of the money</strong> - In the money: the option has exercise value now (call strike below price, or put strike above). Out of the money: it currently has none.
                  </div>
                </div>
              </CollapsibleSection>

              {/* ── Market Basics ── */}
              <CollapsibleSection title="Market Basics - prices & how trades happen">
                <div className="grid gap-2 text-sm">
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Ticker / Symbol</strong> - The short code for a stock, like AAPL or TSLA. Type it in the Symbol field to load a chart and price.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Bid</strong> - The highest price a buyer will pay right now. Sell now and you generally get the bid.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Ask</strong> - The lowest price a seller will accept right now. Buy now and you generally pay the ask.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Spread</strong> - The gap between the bid and ask. A wide spread makes entering and exiting more expensive.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Fill</strong> - When your order actually executes. A full fill trades the whole order; a partial fill trades only some.
                  </div>
                  <div className="p-2 rounded bg-muted/50">
                    <strong>Slippage</strong> - The difference between the price you expected and the price you got. Common with market orders in fast or thin markets.
                  </div>
                </div>
              </CollapsibleSection>

              <CalloutBox type="info">
                Definitions here are general education, not financial advice. Practice on a <strong>Paper account</strong> before risking real money on a <strong>Live account</strong>.
              </CalloutBox>
            </SectionCard>

            {/* CTA */}
            <div className="flex justify-center pt-2 pb-8">
              <Link href="/app">
                <Button size="lg" className="gap-2 px-8">
                  <TrendingUp className="h-5 w-5" />
                  Start Trading Now
                </Button>
              </Link>
            </div>

          </div>
        </div>
      </div>
    </main>
  );
}
