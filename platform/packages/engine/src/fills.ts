import type { Trade } from "./types.js";

export interface ExecutionFill {
  executionId: string;
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  timestamp: string;
  fees: number;
}
export interface TradeIdentity {
  id: string;
  strategyId: string;
  version: string;
  symbol: string;
  initialStop: number;
  entryReason: string;
  exitReason: string;
}
export interface FillReconciliation {
  state: "empty" | "open" | "partial" | "closed";
  remainingQuantity: number;
  realizedPnl: number;
  trade: Trade | null;
}

/** Execution IDs are deduplicated. Accepted orders and disappearing positions are NOT fills. */
export function reconcileFills(
  input: ExecutionFill[],
  identity: TradeIdentity,
): FillReconciliation {
  const seen = new Map<string, ExecutionFill>();
  for (const fill of input) {
    if (
      !fill.executionId ||
      fill.symbol !== identity.symbol ||
      !["buy", "sell"].includes(fill.side) ||
      ![fill.quantity, fill.price].every((v) => Number.isFinite(v) && v > 0) ||
      !Number.isFinite(fill.fees) ||
      fill.fees < 0 ||
      !Number.isFinite(Date.parse(fill.timestamp))
    )
      throw new RangeError("Invalid execution fill");
    const previous = seen.get(fill.executionId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(fill))
      throw new RangeError("Conflicting execution ID");
    seen.set(fill.executionId, fill);
  }
  const fills = [...seen.values()].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  if (!fills.length)
    return {
      state: "empty",
      remainingQuantity: 0,
      realizedPnl: 0,
      trade: null,
    };
  let held = 0,
    buyQty = 0,
    sellQty = 0,
    buyValue = 0,
    sellValue = 0,
    fees = 0,
    buyFees = 0,
    sellFees = 0,
    startedSelling = false;
  for (const fill of fills) {
    if (fill.side === "buy") {
      if (startedSelling)
        throw new RangeError(
          "A new entry after exits requires a separate trade identity",
        );
      held += fill.quantity;
      buyQty += fill.quantity;
      buyValue += fill.quantity * fill.price;
      buyFees += fill.fees;
    } else {
      if (fill.quantity > held + 1e-8)
        throw new RangeError("Sell fills exceed reconciled long inventory");
      startedSelling = true;
      held -= fill.quantity;
      sellQty += fill.quantity;
      sellValue += fill.quantity * fill.price;
      sellFees += fill.fees;
    }
    fees += fill.fees;
  }
  const entry = buyValue / buyQty,
    realizedPnl =
      sellValue - entry * sellQty - (buyFees * sellQty) / buyQty - sellFees;
  if (held > 1e-8)
    return {
      state: sellQty ? "partial" : "open",
      remainingQuantity: held,
      realizedPnl,
      trade: null,
    };
  if (
    !Number.isFinite(identity.initialStop) ||
    identity.initialStop <= 0 ||
    identity.initialStop >= entry
  )
    throw new RangeError(
      "Initial stop must be below the actual entry fill price",
    );
  const exit = sellValue / sellQty,
    grossPnl = sellValue - buyValue;
  return {
    state: "closed",
    remainingQuantity: 0,
    realizedPnl,
    trade: {
      id: identity.id,
      strategyId: identity.strategyId,
      version: identity.version,
      symbol: identity.symbol,
      side: "long",
      entryTime: fills.find((f) => f.side === "buy")!.timestamp,
      exitTime: fills[fills.length - 1].timestamp,
      entryPrice: entry,
      exitPrice: exit,
      quantity: buyQty,
      fees,
      grossPnl,
      pnl: realizedPnl,
      rMultiple: realizedPnl / ((entry - identity.initialStop) * buyQty),
      // Excursions require actual position-period market observations; fills alone cannot establish them.
      mfe: null,
      mae: null,
      reason: identity.exitReason,
      entryReason: identity.entryReason,
      initialStop: identity.initialStop,
      source: "paper",
    },
  };
}
