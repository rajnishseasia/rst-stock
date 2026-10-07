import { Badge } from "@/components/ui/badge";

export interface StockTradeMarketHeaderProps {
  /** The active stock ticker displayed by the chart and trade ticket. */
  symbol: string;
}

/** Identifies the stock that orders from the equity trade rail will target. */
export function StockTradeMarketHeader({ symbol }: StockTradeMarketHeaderProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2.5">
      <span className="min-w-0 truncate font-data text-base font-semibold">
        {symbol || "-"}
      </span>
      <Badge variant="outline" className="shrink-0 text-3xs uppercase tracking-wide">
        Stock
      </Badge>
    </div>
  );
}
