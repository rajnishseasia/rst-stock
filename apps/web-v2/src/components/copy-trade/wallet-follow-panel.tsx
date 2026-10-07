"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useCompleteApiCredentials } from "@/lib/use-complete-api-credentials";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Wallet, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SizingModeTabs } from "./sizing-mode-tabs";
import { SIZING_MODE_PRESENTATION, type SizingMode } from "./mirror-sizing";
import { accountOptionLabel, toAccountOptions } from "./account-targeting";
import { formatPerpPx } from "@/components/perps/perp-format";
import { PERP_PROTECTION_BOUNDS } from "@trade-bot/types";

// ---- constants ---------------------------------------------------------------

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

const DEFAULT_SIZING_MODE: SizingMode = "usd";
const DEFAULT_SIZING_VALUE = 100;

const TP_BOUNDS = PERP_PROTECTION_BOUNDS.takeProfitPct;
const SL_BOUNDS = PERP_PROTECTION_BOUNDS.stopLossPct;

// ---- helpers -----------------------------------------------------------------

function isValidAddress(v: string): boolean {
  return ADDRESS_REGEX.test(v.trim());
}

/** Parse a percent string into a valid number for SL/TP, or return null. */
function parsePct(
  s: string,
  bounds: { min: number; max: number },
): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < bounds.min || n > bounds.max) return null;
  return n;
}

/**
 * A percentage input field (SL or TP). Empty = not set; out-of-range = error.
 * Hook-free: caller owns the value.
 */
function PctInput({
  id,
  value,
  bounds,
  placeholder,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  bounds: { min: number; max: number };
  placeholder: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const invalid =
    value.trim() !== "" &&
    (() => {
      const n = Number(value);
      return !Number.isFinite(n) || n < bounds.min || n > bounds.max;
    })();

  return (
    <Input
      id={id}
      type="number"
      min={bounds.min}
      max={bounds.max}
      step={1}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={cn(
        "h-7 w-24 tabular-nums",
        invalid && "border-destructive text-destructive",
      )}
    />
  );
}

/** Commit-on-blur numeric input for sizing value. */
function SizingValueInput({
  committedValue,
  min,
  max,
  step,
  ariaLabel,
  onCommit,
  disabled,
}: {
  committedValue: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onCommit: (value: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(committedValue));
  const isFocused = useRef(false);

  useEffect(() => {
    if (!isFocused.current) {
      setDraft(String(committedValue));
    }
  }, [committedValue]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) {
      onCommit(Math.max(min, Math.min(max, n)));
    } else {
      setDraft(String(committedValue));
    }
  };

  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        isFocused.current = true;
      }}
      onBlur={() => {
        isFocused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
      aria-label={ariaLabel}
      className="h-7 w-24 tabular-nums"
    />
  );
}

// ---- component ---------------------------------------------------------------

export interface WalletFollowPanelProps {
  /** Caller can dismiss the panel. */
  onClose: () => void;
}

/**
 * "Copy Wallet" panel: enter any Hyperliquid wallet address, preview its open
 * positions and recent fills, then configure sizing / exits and follow it.
 *
 * The panel is mounted/unmounted by the parent (CopyTradePanel) via a toggle
 * button, so it cleanly resets its state every time it is opened.
 */
export function WalletFollowPanel({ onClose }: WalletFollowPanelProps) {
  const trpcUtils = trpc.useUtils();

  // ---- address state -------------------------------------------------------
  const [addressInput, setAddressInput] = useState("");
  // The address committed for the preview query. Only set when the user clicks
  // "Look up" with a valid address, so the query never fires mid-type.
  const [lookedUpAddress, setLookedUpAddress] = useState<string | null>(null);

  // ---- sizing state --------------------------------------------------------
  const [sizingMode, setSizingMode] = useState<SizingMode>(DEFAULT_SIZING_MODE);
  const [sizingValue, setSizingValue] = useState(DEFAULT_SIZING_VALUE);

  // ---- exit state ----------------------------------------------------------
  const [slDraft, setSlDraft] = useState("");
  const [tpDraft, setTpDraft] = useState("");

  // ---- account state -------------------------------------------------------
  const [credentialId, setCredentialId] = useState<string | null>(null);

  // ---- accounts query (HL only) --------------------------------------------
  const accountsQuery = useCompleteApiCredentials("hyperliquid");
  const allAccounts = toAccountOptions(accountsQuery.accounts);
  // Wallet copy only makes sense with an HL account: the source wallet is a
  // perp wallet, and the fill-placement path requires an HL destination.
  const hlAccounts = allAccounts.filter((a) => a.provider === "hyperliquid");

  // Auto-select the first HL account when the list loads, so the user doesn't
  // have to explicitly pick when they only have one.
  useEffect(() => {
    if (credentialId === null && hlAccounts.length === 1) {
      setCredentialId(hlAccounts[0]!.id);
    }
  }, [credentialId, hlAccounts]);

  // ---- wallet preview query ------------------------------------------------
  const previewQuery = trpc.hyperliquid.walletPreview.useQuery(
    { address: lookedUpAddress ?? "0x0000000000000000000000000000000000000000" },
    {
      enabled: !!lookedUpAddress,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  );

  // ---- follow mutation -----------------------------------------------------
  const followMutation = trpc.copyTradeFollows.followWallet.useMutation({
    onSuccess: () => {
      void trpcUtils.copyTradeFollows.list.invalidate();
      void trpcUtils.copyTrade.feed.invalidate();
      toast.success("Wallet follow saved.");
      onClose();
    },
    onError: (err) => {
      toast.error(err.message || "Could not follow wallet.");
    },
  });

  // ---- derived state -------------------------------------------------------
  const addressValid = isValidAddress(addressInput);
  const preview = previewQuery.data;
  const currentMode = SIZING_MODE_PRESENTATION[sizingMode];

  const slValue = parsePct(slDraft, SL_BOUNDS);
  const tpValue = parsePct(tpDraft, TP_BOUNDS);
  const slInvalid =
    slDraft.trim() !== "" && slValue === null;
  const tpInvalid =
    tpDraft.trim() !== "" && tpValue === null;

  const canFollow =
    !!lookedUpAddress &&
    !previewQuery.isError &&
    !slInvalid &&
    !tpInvalid &&
    !followMutation.isPending;

  // ---- handlers ------------------------------------------------------------
  function handleLookup() {
    const addr = addressInput.trim();
    if (!isValidAddress(addr)) return;
    setLookedUpAddress(addr);
  }

  function handleFollow() {
    if (!lookedUpAddress) return;

    const sl = parsePct(slDraft, SL_BOUNDS);
    const tp = parsePct(tpDraft, TP_BOUNDS);

    followMutation.mutate({
      walletAddress: lookedUpAddress,
      sizingMode,
      sizingValue,
      credentialId: credentialId ?? null,
      perpStopLossPct: sl ?? null,
      perpTakeProfitPct: tp ?? null,
    });
  }

  // ---- render --------------------------------------------------------------
  return (
    <div
      className="mt-2 rounded-md border border-border bg-muted/20 p-3"
      data-testid="wallet-follow-panel"
    >
      {/* ---- header ---- */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold">Copy any Hyperliquid wallet</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close copy wallet panel"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ---- address row ---- */}
      <div className="mb-3 flex items-center gap-2">
        <Input
          type="text"
          placeholder="0x..."
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && addressValid) handleLookup();
          }}
          aria-label="Hyperliquid wallet address"
          className="h-7 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          disabled={!addressValid || previewQuery.isFetching}
          onClick={handleLookup}
        >
          {previewQuery.isFetching ? "Looking up..." : "Look up"}
        </Button>
      </div>

      {/* ---- preview ---- */}
      {lookedUpAddress && (
        <div className="mb-3 rounded-md border border-border bg-background/50 p-2">
          {previewQuery.isLoading && (
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="h-3.5 w-40" />
            </div>
          )}

          {previewQuery.isError && (
            <p className="text-2xs text-destructive">
              Could not load wallet data. Check the address and try again.
            </p>
          )}

          {preview && (
            <>
              {/* Open positions */}
              <p className="mb-1 text-2xs font-medium text-muted-foreground uppercase tracking-wide">
                Open positions
              </p>
              {preview.positions.length === 0 ? (
                <p className="text-2xs text-muted-foreground">No open positions</p>
              ) : (
                <ul className="mb-2 space-y-0.5">
                  {preview.positions.slice(0, 6).map((pos) => (
                    <li
                      key={pos.coin}
                      className="flex items-center justify-between gap-2 text-2xs"
                    >
                      <span className="font-medium">{pos.coin}</span>
                      <span
                        className={cn(
                          "font-mono",
                          pos.side === "long" ? "text-emerald-400" : "text-rose-400",
                        )}
                      >
                        {pos.side === "long" ? "Long" : "Short"} {pos.size}
                      </span>
                      <span className="text-muted-foreground font-mono">
                        @ {formatPerpPx(pos.entryPx)}
                      </span>
                    </li>
                  ))}
                  {preview.positions.length > 6 && (
                    <li className="text-2xs text-muted-foreground">
                      +{preview.positions.length - 6} more
                    </li>
                  )}
                </ul>
              )}

              {/* Recent fills */}
              <p className="mb-1 text-2xs font-medium text-muted-foreground uppercase tracking-wide">
                Recent fills
              </p>
              {preview.recentFills.length === 0 ? (
                <p className="text-2xs text-muted-foreground">No recent fills</p>
              ) : (
                <ul className="space-y-0.5">
                  {preview.recentFills.slice(0, 5).map((fill) => (
                    <li
                      key={fill.tid}
                      className="flex items-center justify-between gap-2 text-2xs"
                    >
                      <span className="font-medium">{fill.coin}</span>
                      <span
                        className={cn(
                          "font-mono",
                          fill.side === "buy" ? "text-emerald-400" : "text-rose-400",
                        )}
                      >
                        {fill.dir}
                      </span>
                      <span className="text-muted-foreground font-mono">
                        {fill.sz} @ {formatPerpPx(fill.px)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {/* ---- settings ---- */}
      <div className="space-y-2.5">
        {/* Sizing */}
        <div>
          <Label className="mb-1 text-2xs text-muted-foreground">Sizing</Label>
          <div className="flex flex-wrap items-center gap-2">
            <SizingModeTabs value={sizingMode} onChange={setSizingMode} compact />
            <SizingValueInput
              committedValue={sizingValue}
              min={currentMode.min}
              max={currentMode.max}
              step={currentMode.step}
              ariaLabel={currentMode.aria}
              onCommit={setSizingValue}
            />
            <span className="text-2xs text-muted-foreground">{currentMode.caption}</span>
          </div>
        </div>

        {/* SL / TP */}
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <Label htmlFor="wallet-sl" className="mb-1 text-2xs text-muted-foreground">
              Stop loss (% of margin)
            </Label>
            <PctInput
              id="wallet-sl"
              value={slDraft}
              bounds={SL_BOUNDS}
              placeholder={`${SL_BOUNDS.min}..${SL_BOUNDS.max}%`}
              onChange={setSlDraft}
            />
          </div>
          <div>
            <Label htmlFor="wallet-tp" className="mb-1 text-2xs text-muted-foreground">
              Take profit (% of margin)
            </Label>
            <PctInput
              id="wallet-tp"
              value={tpDraft}
              bounds={TP_BOUNDS}
              placeholder={`${TP_BOUNDS.min}..${TP_BOUNDS.max}%`}
              onChange={setTpDraft}
            />
          </div>
        </div>

        {/* Account (HL only) */}
        <div>
          <Label className="mb-1 text-2xs text-muted-foreground">
            Mirror to Hyperliquid account
          </Label>
          {accountsQuery.isLoading ? (
            <Skeleton className="h-7 w-44" />
          ) : hlAccounts.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              No Hyperliquid account connected. Enable perps in settings first.
            </p>
          ) : (
            <Select
              value={credentialId ?? ""}
              onValueChange={(v) => setCredentialId(v || null)}
            >
              <SelectTrigger className="h-7 w-full max-w-xs text-xs">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {hlAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id} className="text-xs">
                    {accountOptionLabel(account)}
                    {account.accountType === "LIVE" && (
                      <span className="ml-1.5 text-2xs text-rose-400">LIVE</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            disabled={!canFollow}
            onClick={handleFollow}
          >
            {followMutation.isPending ? "Saving..." : "Follow wallet"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-muted-foreground"
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
