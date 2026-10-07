export type AssetCoverage = "stocks" | "perps" | "both";
export type AssetClass = Exclude<AssetCoverage, "both">;

const ASSET_COVERAGE_LABELS: Record<AssetCoverage, string> = {
  stocks: "Stocks",
  perps: "Perps",
  both: "Both",
};

export function assetCoveragePresentation(coverage: AssetCoverage) {
  return {
    label: ASSET_COVERAGE_LABELS[coverage],
    title: `Calls in this window: ${ASSET_COVERAGE_LABELS[coverage]}`,
    className:
      coverage === "perps"
        ? "border-primary/40 text-primary"
        : coverage === "both"
          ? "border-amber-500/40 text-amber-500"
          : undefined,
  };
}

export function assetClassPresentation(assetClass: AssetClass) {
  const presentation = assetCoveragePresentation(assetClass);
  return {
    ...presentation,
    title: `This call's asset kind: ${presentation.label}`,
  };
}
