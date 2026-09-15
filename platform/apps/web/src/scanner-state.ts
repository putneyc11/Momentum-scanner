import type { Stock } from "./types";

export const SCANNER_MIN_CHANGE_PCT = 25;

export function qualifiesMover(stock: Pick<Stock, "changePct">): boolean {
  return (
    Number.isFinite(stock.changePct) && stock.changePct > SCANNER_MIN_CHANGE_PCT
  );
}

/** Keep nonqualifiers cached: they may cross back above the cutoff on a tick. */
export function applyScannerTick(
  stocks: Stock[],
  symbol: string,
  price: number,
  time: string,
): Stock[] {
  const timestamp = Date.parse(time);
  if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0)
    return stocks;
  return stocks.map((stock) => {
    if (stock.symbol !== symbol || timestamp < Date.parse(stock.updatedAt))
      return stock;
    const previousClose =
      stock.previousClose ??
      (Number.isFinite(stock.price) && Number.isFinite(stock.changePct)
        ? stock.price / (1 + stock.changePct / 100)
        : NaN);
    return {
      ...stock,
      price,
      previousClose,
      changePct:
        Number.isFinite(previousClose) && previousClose > 0
          ? (price / previousClose - 1) * 100
          : NaN,
      updatedAt: time,
    };
  });
}
