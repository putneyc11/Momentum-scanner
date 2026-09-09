import { computeMetrics, sessionDate, type Trade } from "@momentum/engine";
import { Store } from "./store.js";

export type Candidate = {
  id: string;
  strategyId: string;
  version: string;
  createdAt: string;
  status: string;
  parameters: Record<string, number>;
  researchId?: string;
  notes?: string;
};
/** Review gates are deliberately independent of the button or the global execution flag. */
export async function candidateEvidence(
  store: Store,
  candidate: Candidate,
  mode: string,
) {
  const all = (
    await store.list<(Trade & { candidateId?: string })[]>("shadowCandidate:")
  ).flat();
  const trades = all.filter(
    (t) =>
      t.candidateId === candidate.id &&
      t.strategyId === candidate.strategyId &&
      t.version === candidate.version &&
      t.entryTime >= candidate.createdAt,
  );
  const metrics = computeMetrics(trades);
  const sessions = new Set(trades.map((t) => sessionDate(t.entryTime))).size;
  const reasons: string[] = [];
  if (mode !== "paper")
    reasons.push("Demonstration data cannot authorize broker orders.");
  const research = candidate.researchId
    ? await store.get<any>(`research:${candidate.researchId}`, null)
    : null;
  const tested = research?.report?.challengers?.find(
    (c: any) => c.id === candidate.id && c.version === candidate.version,
  );
  if (research?.status !== "completed" || !tested)
    reasons.push(
      "A completed chronological research report is required for this exact candidate.",
    );
  else {
    for (const reason of tested.rejectionReasons || [])
      if (reason !== "EXPLICIT_PAPER_PROMOTION_NOT_AUTHORIZED")
        reasons.push(reason);
    const same =
      Object.keys(tested.parameters).length ===
        Object.keys(candidate.parameters).length &&
      Object.entries(tested.parameters).every(
        ([k, v]) => candidate.parameters[k] === v,
      );
    if (!same)
      reasons.push("Parameters differ from the tested immutable version.");
    if (!research.report.split?.holdout?.length)
      reasons.push("An untouched holdout is required.");
  }
  if (trades.length < 20)
    reasons.push(
      `Observe at least 20 subsequent shadow trades (${trades.length}/20).`,
    );
  if (sessions < 5)
    reasons.push(
      `Observe at least 5 subsequent trading sessions (${sessions}/5).`,
    );
  if (
    metrics.netPnl <= 0 ||
    metrics.profitFactor === null ||
    metrics.profitFactor < 1.2
  )
    reasons.push(
      "Subsequent shadow evidence must have positive cost-adjusted P&L and profit factor of at least 1.2.",
    );
  if (metrics.maxDrawdownPct > 3)
    reasons.push(
      "Subsequent shadow drawdown exceeds 3% of the simulation capital.",
    );
  if (trades.some((t) => t.source !== "simulation" || t.reason === "data_end"))
    reasons.push("Only finalized forward shadow observations qualify.");
  return {
    trades,
    metrics,
    sessions,
    promotion: {
      eligible: reasons.length === 0,
      reasons: [...new Set(reasons)],
      policy:
        "Explicit operator approval enables this version for PAPER only. No evidence guarantees future profitability.",
    },
  };
}
