import type { PoolDb } from "@trade-bot/db";
import { getAlpacaClient } from "../alpaca.js";
import { getMarketResearchForSymbol } from "../research/market-research.js";

type SelectedSignalContext = {
  signalId?: string;
  symbol?: string;
  content?: string;
};

type StockContextOptions = {
  db: PoolDb;
  userId: string;
  alpacaCredentialId?: string;
  activeAccountType?: "PAPER" | "LIVE";
  activeSymbol?: string;
  selectedSignal?: SelectedSignalContext;
};

export type ResearchSource = {
  id: string;
  type: "filing" | "news";
  title: string;
  url: string;
  date: string | null;
  source: string;
};

function money(value: string | number | null | undefined) {
  const numeric = typeof value === "number" ? value : Number.parseFloat(value || "0");
  if (!Number.isFinite(numeric)) return "n/a";
  return `$${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function percent(value: string | number | null | undefined) {
  const numeric = typeof value === "number" ? value : Number.parseFloat(value || "0");
  if (!Number.isFinite(numeric)) return "n/a";
  return `${(numeric * 100).toFixed(2)}%`;
}

function truncate(value: string | undefined, maxLength: number) {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export async function buildStockChatContext(options: StockContextOptions) {
  const sections: string[] = [];
  const warnings: string[] = [];
  const sources: ResearchSource[] = [];
  const symbol = options.activeSymbol || options.selectedSignal?.symbol;

  sections.push(
    `Active account mode: ${options.activeAccountType || "not selected"}`,
    `Active symbol: ${symbol || "none selected"}`
  );

  if (options.selectedSignal?.content) {
    sections.push(
      `Selected signal: ${options.selectedSignal.symbol ? `$${options.selectedSignal.symbol}: ` : ""}${truncate(
        options.selectedSignal.content,
        1200
      )}`
    );
  }

  if (symbol) {
    try {
      const research = await getMarketResearchForSymbol(symbol);
      if (research.company) {
        sections.push(
          `Public company match: ${research.company.title} (${research.company.ticker}), CIK ${research.company.cik}`
        );
      }

      if (research.filings.length > 0) {
        const filingSources = research.filings.map((filing, index) => {
          const id = `F${index + 1}`;
          sources.push({
            id,
            type: "filing",
            title: `${filing.form}${filing.description ? ` - ${filing.description}` : ""}`,
            url: filing.url,
            date: filing.filingDate || null,
            source: "SEC EDGAR",
          });
          return { id, filing };
        });

        sections.push(
          [
            "Recent SEC filings:",
            ...filingSources.map(({ id, filing }) =>
              [
                `- [${id}] ${filing.form}`,
                `filed ${filing.filingDate}`,
                filing.reportDate ? `report ${filing.reportDate}` : "",
                filing.description || filing.primaryDocument,
                filing.url,
              ]
                .filter(Boolean)
                .join(" | ")
            ),
          ].join("\n")
        );
      }

      if (research.news.length > 0) {
        const newsSources = research.news.map((article, index) => {
          const id = `N${index + 1}`;
          sources.push({
            id,
            type: "news",
            title: article.title,
            url: article.url,
            date: article.publishedAt,
            source: article.domain || "GDELT",
          });
          return { id, article };
        });

        sections.push(
          [
            "Recent news search results:",
            ...newsSources.map(({ id, article }) =>
              [
                `- [${id}] ${article.title}`,
                article.domain ? `source ${article.domain}` : "",
                article.publishedAt ? `seen ${article.publishedAt}` : "",
                article.url,
              ]
                .filter(Boolean)
                .join(" | ")
            ),
          ].join("\n")
        );
      }

      // research.warnings already distinguish genuine errors ("Could not...")
      // from empty results ("No recent filings/news found for X") and
      // equity-only notes for crypto/perp markets. Pass them through as-is.
      warnings.push(...research.warnings);
    } catch {
      // Only reached on an unexpected failure of the research pipeline itself.
      warnings.push("Could not load public filings/news research due to an unexpected error.");
    }
  }

  if (!options.alpacaCredentialId) {
    warnings.push("No Alpaca account is selected, so portfolio context is unavailable.");
    return { context: sections.join("\n"), warnings, sources };
  }

  try {
    const { client, credentials } = await getAlpacaClient(options.db, options.userId, {
      credentialId: options.alpacaCredentialId,
    });

    const [accountResult, positionsResult, ordersResult] = await Promise.allSettled([
      client.getAccount(),
      client.getPositions(),
      client.getOrders("open", 25),
    ]);

    sections.push(
      `Broker context: Alpaca ${credentials.accountType === "LIVE" ? "live" : "paper"} account`
    );

    if (accountResult.status === "fulfilled") {
      const account = accountResult.value;
      sections.push(
        [
          "Account summary:",
          `- Status: ${account.status}`,
          `- Portfolio value: ${money(account.portfolio_value)}`,
          `- Cash: ${money(account.cash)}`,
          `- Buying power: ${money(account.buying_power)}`,
          `- Trading blocked: ${account.trading_blocked ? "yes" : "no"}`,
        ].join("\n")
      );
    } else {
      warnings.push("Could not fetch Alpaca account summary.");
    }

    if (positionsResult.status === "fulfilled") {
      const positions = positionsResult.value;
      if (positions.length === 0) {
        sections.push("Open positions: none");
      } else {
        sections.push(
          [
            "Open positions:",
            ...positions.slice(0, 25).map((position) =>
              [
                `- ${position.symbol}`,
                `${position.side}`,
                `qty ${position.qty}`,
                `avg ${money(position.avg_entry_price)}`,
                `current ${money(position.current_price)}`,
                `market value ${money(position.market_value)}`,
                `unrealized P/L ${money(position.unrealized_pl)} (${percent(position.unrealized_plpc)})`,
              ].join(", ")
            ),
          ].join("\n")
        );
      }
    } else {
      warnings.push("Could not fetch Alpaca positions.");
    }

    if (ordersResult.status === "fulfilled") {
      const orders = ordersResult.value;
      if (orders.length === 0) {
        sections.push("Open orders: none");
      } else {
        sections.push(
          [
            "Open orders:",
            ...orders.slice(0, 25).map((order) =>
              [
                `- ${order.symbol}`,
                order.side,
                order.type,
                `qty ${order.qty || "n/a"}`,
                `status ${order.status}`,
                order.limit_price ? `limit ${money(order.limit_price)}` : "",
                order.stop_price ? `stop ${money(order.stop_price)}` : "",
              ]
                .filter(Boolean)
                .join(", ")
            ),
          ].join("\n")
        );
      }
    } else {
      warnings.push("Could not fetch Alpaca open orders.");
    }
  } catch {
    warnings.push("Could not load Alpaca context for the selected account.");
  }

  return { context: sections.join("\n\n"), warnings, sources };
}
