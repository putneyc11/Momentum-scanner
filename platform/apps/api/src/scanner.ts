import type { Stock } from "./market.js";

export const SCANNER_MIN_CHANGE_PCT = 25;

/** Scanner membership is a view, never the worker's tracking/risk universe. */
export function qualifiesMover(stock: Pick<Stock, "changePct">): boolean {
  return (
    Number.isFinite(stock.changePct) && stock.changePct > SCANNER_MIN_CHANGE_PCT
  );
}

export function withPreviousClose(
  stock: Stock,
): Stock & { previousClose: number | null } {
  const previousClose =
    Number.isFinite(stock.price) && Number.isFinite(stock.changePct)
      ? stock.price / (1 + stock.changePct / 100)
      : NaN;
  return {
    ...stock,
    previousClose:
      Number.isFinite(previousClose) && previousClose > 0
        ? previousClose
        : null,
  };
}
