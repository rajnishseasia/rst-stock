"use client";

import { useEffect, useState } from "react";
import { COPY_PERP_MAX_LEVERAGE_MAX, COPY_PERP_MAX_LEVERAGE_MIN } from "@trade-bot/types";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const LEVERAGE_LABEL = "Copy-trading maximum leverage";
const LEVERAGE_EXPLANATION =
  "Applies to every automatic perp copy. Leaders and markets can use less; no follow can use more.";

/** Return a parsed cap only when the input is an integer inside the product bounds. */
export function parseCopyPerpLeverage(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < COPY_PERP_MAX_LEVERAGE_MIN ||
    parsed > COPY_PERP_MAX_LEVERAGE_MAX
  ) {
    return null;
  }
  return parsed;
}

export function shouldShowCopyTradeLeverageSuccess(input: {
  mutationSucceeded: boolean;
  draftLeverage: string;
  savedValue: number | null;
}): boolean {
  return (
    input.mutationSucceeded &&
    input.savedValue != null &&
    parseCopyPerpLeverage(input.draftLeverage) === input.savedValue
  );
}

export function CopyTradeLeverageSettings() {
  const settingsUtils = trpc.useUtils();
  const settingsQuery = trpc.userSettings.getCopyPerpLeverageSettings.useQuery(undefined);
  const savedLeverage = settingsQuery.data?.globalPerpMaxLeverage ?? null;
  const [draftLeverage, setDraftLeverage] = useState(
    savedLeverage == null ? "" : String(savedLeverage),
  );
  const [savedValue, setSavedValue] = useState<number | null>(savedLeverage);

  useEffect(() => {
    if (savedLeverage == null) return;
    setDraftLeverage(String(savedLeverage));
    setSavedValue(savedLeverage);
  }, [savedLeverage]);

  const saveMutation = trpc.userSettings.setCopyPerpMaxLeverage.useMutation({
    onSuccess: (result) => {
      setDraftLeverage(String(result.globalPerpMaxLeverage));
      setSavedValue(result.globalPerpMaxLeverage);
      void Promise.all([
        settingsUtils.userSettings.getCopyPerpLeverageSettings.invalidate(),
        settingsUtils.copyTradeFollows.list.invalidate(),
      ]);
    },
    onError: () => {
      // Keep the last confirmed value visible after a rejected write. This
      // also avoids making a failed global decrease look like a follow update.
      setDraftLeverage(savedValue == null ? "" : String(savedValue));
    },
  });

  const parsedDraft = parseCopyPerpLeverage(draftLeverage);
  const isUnchanged = parsedDraft != null && parsedDraft === savedValue;
  const validationError =
    draftLeverage.length > 0 && parsedDraft == null
      ? `Enter an integer from ${COPY_PERP_MAX_LEVERAGE_MIN} to ${COPY_PERP_MAX_LEVERAGE_MAX}.`
      : null;
  const queryError = settingsQuery.isError ? settingsQuery.error?.message : null;
  const mutationError = saveMutation.isError ? saveMutation.error?.message : null;
  const errorMessage = validationError ?? mutationError ?? queryError;
  const isLoading = settingsQuery.isLoading;
  const isSaveDisabled =
    isLoading ||
    saveMutation.isPending ||
    savedValue == null ||
    parsedDraft == null ||
    isUnchanged;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaveDisabled || parsedDraft == null) return;
    saveMutation.mutate({ globalPerpMaxLeverage: parsedDraft });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Copy Trading</CardTitle>
        <CardDescription>{LEVERAGE_EXPLANATION}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="copy-trade-leverage">{LEVERAGE_LABEL}</Label>
            <Input
              id="copy-trade-leverage"
              data-testid="copy-trade-leverage-input"
              type="number"
              inputMode="numeric"
              min={COPY_PERP_MAX_LEVERAGE_MIN}
              max={COPY_PERP_MAX_LEVERAGE_MAX}
              step={1}
              value={draftLeverage}
              onChange={(event) => setDraftLeverage(event.target.value)}
              disabled={isLoading || savedValue == null || saveMutation.isPending}
              aria-invalid={errorMessage ? true : undefined}
              aria-describedby="copy-trade-leverage-help copy-trade-leverage-status"
            />
            <p id="copy-trade-leverage-help" className="text-xs text-muted-foreground">
              Enter a whole-number maximum from {COPY_PERP_MAX_LEVERAGE_MIN}x to{" "}
              {COPY_PERP_MAX_LEVERAGE_MAX}x.
            </p>
          </div>

          {isLoading && (
            <p className="text-sm text-muted-foreground">Loading copy-trading leverage settings...</p>
          )}
          {errorMessage && (
            <p id="copy-trade-leverage-status" className="text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          )}
          {!errorMessage &&
            shouldShowCopyTradeLeverageSuccess({
              mutationSucceeded: saveMutation.isSuccess,
              draftLeverage,
              savedValue,
            }) && (
            <p id="copy-trade-leverage-status" className="text-sm text-emerald-600" role="status">
              Copy-trading maximum leverage saved.
            </p>
          )}

          <Button
            type="submit"
            data-testid="copy-trade-leverage-save"
            disabled={isSaveDisabled}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
