/**
 * The account-shaped props both halves of the terminal describe themselves
 * with. `./trading-app-content` owns the state (which broker account is
 * selected, an option copy in flight) and `./venue-aware-panels` types the
 * props it is handed, so neither can own these without the other importing a
 * component module just to name a type.
 *
 * They used to live in `page.tsx`, which cannot export them: a Next.js page
 * file may export only `default` plus the framework's own config keys, and any
 * other export fails the page-type check `next build` generates into
 * .next/types.
 */

export type AccountMode = "PAPER" | "LIVE";

export type OptionCopyPrefill = {
  assetType: "OPTION";
  optionExpiration: string;
  optionStrike: number;
  optionType: "CALL" | "PUT";
  tradeAction?: "BuyToOpen" | "SellToClose";
};
