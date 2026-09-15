import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Flask,
  Funnel,
  GitBranch,
  MagnifyingGlass,
  Play,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { api, useResource } from "./api";
import type {
  Overview,
  Parameter,
  Research,
  Strategy,
  Trade,
  Metrics,
  StrategyVersion,
} from "./types";
import { dateTime, label, money, number, easternDate } from "./format";
import {
  Badge,
  Empty,
  ErrorNotice,
  ExportTrades,
  Loading,
  Metric,
  Money,
  Modal,
  Panel,
  StateBadge,
  TradeTable,
} from "./ui";
import Chart from "./Chart";
import { StrategyTable } from "./App";

const listOf = <T,>(
  data: T[] | Record<string, T[]> | null,
  key: string,
): T[] => (Array.isArray(data) ? data : data?.[key] || []);
function versionDiff(version: StrategyVersion, strategy: Strategy) {
  if (version.diff) return version.diff;
  return Object.fromEntries(
    Object.entries(version.parameters || {}).flatMap(([key, to]) => {
      const parameter = strategy.parameters?.[key];
      const from = typeof parameter === "number" ? parameter : parameter?.value;
      return from !== undefined && from !== to ? [[key, { from, to }]] : [];
    }),
  );
}
function explainGate(reason: string) {
  if (!reason.includes("_")) return reason;
  const names: Record<string, string> = {
    TRAIN_SAMPLE_TOO_SMALL: "Too few training trades",
    DOES_NOT_IMPROVE_TRAIN_BASELINE: "Did not improve the training baseline",
    NOT_SELECTED_ON_TRAIN: "Not selected after training",
    VALIDATION_SAMPLE_TOO_SMALL: "Too few validation trades",
    VALIDATION_NOT_PROFITABLE_AFTER_COSTS:
      "Validation was not profitable after costs",
    VALIDATION_PROFIT_FACTOR_UNPROVEN: "Validation profit factor is unproven",
    HOLDOUT_SAMPLE_TOO_SMALL: "Too few independent holdout trades",
    HOLDOUT_NOT_PROFITABLE_AFTER_COSTS:
      "Holdout was not profitable after costs",
    HOLDOUT_PROFIT_FACTOR_UNPROVEN: "Holdout profit factor is unproven",
    MINIMUM_TRAIN_EVIDENCE_REQUIRED: "More training evidence is required",
    MINIMUM_REAL_SESSIONS_REQUIRED: "More real market sessions are required",
    EXPLICIT_PAPER_PROMOTION_NOT_AUTHORIZED:
      "Paper execution has not been authorized",
  };
  return reason
    .split(";")
    .map((item) => {
      const [key, detail] = item.trim().split(":");
      return `${names[key] || label(key).toLowerCase()}${detail ? ` (${detail})` : ""}`;
    })
    .join(". ");
}
function Title({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export function StrategiesPage({
  navigate,
}: {
  navigate: (path: string) => void;
}) {
  const resource = useResource<Strategy[] | { strategies: Strategy[] }>(
    "/strategies",
    15000,
  );
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const strategies = listOf(resource.data, "strategies");
  const filtered = strategies.filter(
    (s) =>
      `${s.name} ${s.family} ${s.description}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (status === "all" || s.status === status),
  );
  return (
    <>
      <Title
        eyebrow="STRATEGY LIBRARY"
        title="Know what you're testing."
        description="Compare the rules, outcomes, and evidence behind every strategy."
      />
      <div className="filter-bar">
        <label className="search-field">
          <MagnifyingGlass />
          <input
            aria-label="Search strategies"
            placeholder="Search strategies or setups…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="select-label">
          <Funnel size={16} />
          <select
            aria-label="Filter strategy status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All statuses</option>
            {[...new Set(strategies.map((s) => s.status))].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <span className="subtle">{filtered.length} strategies</span>
      </div>
      {resource.error && (
        <ErrorNotice
          message={resource.error}
          retry={() => resource.refresh()}
        />
      )}{" "}
      {resource.loading ? (
        <Loading />
      ) : (
        <StrategyTable strategies={filtered} navigate={navigate} />
      )}
      <div className="inset-note inline-note">
        <ShieldCheck size={22} />
        <div>
          <h3>Change a hypothesis, preserve the evidence.</h3>
          <p>
            Parameter edits create a candidate version. Active strategy versions
            remain immutable, and a candidate must pass research gates before
            receiving an allocation.
          </p>
        </div>
      </div>
    </>
  );
}

export function StrategyDetail({
  id,
  onBack,
  onTrade,
}: {
  id: string;
  onBack: () => void;
  onTrade: (t: Trade) => void;
}) {
  const [strategyBook, setStrategyBook] = useState("simulation");
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [controlError, setControlError] = useState("");
  const [controlBusy, setControlBusy] = useState(false);
  const resource = useResource<Strategy>(
    `/strategies/${encodeURIComponent(id)}?source=${strategyBook}`,
    15000,
  );
  const [tab, setTab] = useState("performance");
  const [values, setValues] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [book, setBook] = useState("all");
  const [tradeDay, setTradeDay] = useState("all");
  const s = resource.data;
  const parameters = useMemo(
    () =>
      Object.entries(s?.parameters || {}).map(
        ([key, p]) =>
          [
            key,
            typeof p === "number"
              ? { value: p, min: p, max: p, step: 0.01, label: label(key) }
              : p,
          ] as [string, Parameter],
      ),
    [s?.parameters],
  );
  useEffect(() => {
    if (s)
      setValues(
        Object.fromEntries(parameters.map(([key, p]) => [key, p.value])),
      );
  }, [s?.id, s?.version, s?.book]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult("");
    try {
      await api(`/strategies/${encodeURIComponent(id)}/candidates`, {
        method: "POST",
        body: JSON.stringify({ parameters: values, notes }),
      });
      setResult(
        "Candidate saved. The active strategy has not changed. Review its version below, then test it in the research lab.",
      );
      setNotes("");
      await resource.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const trades = (s?.trades || []).filter(
    (t) =>
      (book === "all" || t.source === book) &&
      (tradeDay === "all" || easternDate(t.entryTime) === tradeDay),
  );
  const days = [
    ...new Set((s?.trades || []).map((t) => easternDate(t.entryTime))),
  ]
    .sort()
    .reverse();
  return (
    <>
      <button className="text-button back-link" onClick={onBack}>
        <ArrowLeft />
        All strategies
      </button>
      {resource.error && (
        <ErrorNotice
          message={resource.error}
          retry={() => resource.refresh()}
        />
      )}{" "}
      {resource.loading ? (
        <Loading />
      ) : !s ? (
        <Empty title="Strategy unavailable">
          Check the strategy identifier and connection.
        </Empty>
      ) : (
        <>
          <Title
            eyebrow={`${s.family || "MOMENTUM"} STRATEGY`}
            title={s.name}
            description={
              s.description ||
              "Inspect the rules, trade record, and research versions of this strategy."
            }
          >
            <select
              aria-label="Strategy execution book"
              value={strategyBook}
              onChange={(e) => setStrategyBook(e.target.value)}
            >
              <option value="simulation">Shadow simulation</option>
              <option value="paper">Paper broker fills</option>
            </select>
            <StateBadge state={s.status} />
            <Badge>Version {s.version}</Badge>
            {s.approvedVersion && (
              <button
                className="button secondary"
                disabled={controlBusy}
                onClick={async () => {
                  setControlBusy(true);
                  setControlError("");
                  try {
                    await api(`/strategies/${encodeURIComponent(id)}/disable`, {
                      method: "POST",
                    });
                    await resource.refresh();
                  } catch (e) {
                    setControlError((e as Error).message);
                  } finally {
                    setControlBusy(false);
                  }
                }}
              >
                Disable paper entries
              </button>
            )}
          </Title>
          {controlError && <ErrorNotice message={controlError} />}
          <div className="tab-strip" aria-label="Strategy views">
            {["performance", "trades", "rules & levers", "versions"].map(
              (t) => (
                <button
                  key={t}
                  className={tab === t ? "active" : ""}
                  aria-pressed={tab === t}
                  onClick={() => setTab(t)}
                >
                  {label(t)}
                  {t === "trades" && <span>{s.trades?.length || 0}</span>}
                </button>
              ),
            )}
          </div>
          {tab === "performance" && (
            <>
              <div className="metrics-strip">
                <Metric
                  label={
                    strategyBook === "paper"
                      ? "P&L before fee reconciliation"
                      : "Net modeled P&L"
                  }
                  value={<Money value={s.metrics.netPnl} />}
                  detail={`${s.metrics.trades} closed ${strategyBook === "paper" ? "paper" : "shadow"} trades`}
                />
                <Metric
                  label="Hit rate"
                  value={`${number(s.metrics.winRate, 1)}%`}
                  detail={
                    s.metrics.winRateConfidence95
                      ? `95% interval ${s.metrics.winRateConfidence95.map((v) => `${number(v, 1)}%`).join(" to ")}`
                      : "Closed wins / closed trades"
                  }
                />
                <Metric
                  label="Profit factor"
                  value={number(s.metrics.profitFactor)}
                  detail="Gross wins / gross losses"
                />
                <Metric
                  label="Expectancy"
                  value={money(s.metrics.expectancy)}
                  detail="Average net result per trade"
                />
              </div>
              <Chart
                points={s.equity || []}
                trades={s.trades || []}
                onTrade={onTrade}
                title={`${s.name} · cumulative P&L`}
              />
              <div className="detail-grid">
                <Panel title="Trade quality">
                  <dl className="definition-list padded">
                    <div>
                      <dt>Average win</dt>
                      <dd className="positive-text">
                        {money(s.metrics.avgWin)}
                      </dd>
                    </div>
                    <div>
                      <dt>Average loss</dt>
                      <dd className="negative-text">
                        {money(s.metrics.avgLoss)}
                      </dd>
                    </div>
                    <div>
                      <dt>Average result in R</dt>
                      <dd>{number(s.metrics.avgR)}</dd>
                    </div>
                    <div>
                      <dt>Maximum drawdown</dt>
                      <dd>{money(s.metrics.maxDrawdown)}</dd>
                    </div>
                    <div>
                      <dt>Average hold</dt>
                      <dd>{number(s.metrics.averageHoldMinutes, 1)} minutes</dd>
                    </div>
                    <div>
                      <dt>Recorded fees</dt>
                      <dd>{money(s.metrics.fees)}</dd>
                    </div>
                  </dl>
                </Panel>
                <Panel title="Interpret the evidence">
                  <div className="prose-block">
                    <h3>
                      {s.metrics.trades < 30
                        ? "Early evidence. Small sample."
                        : "Look beyond the headline return."}
                    </h3>
                    <p>
                      {s.metrics.trades < 30
                        ? `This strategy has ${s.metrics.trades} closed trades in the reported sample. A high hit rate can change sharply with a few additional outcomes.`
                        : "Compare expectancy after costs, the size of losses, and performance on untouched data before changing risk."}
                    </p>
                    <p>
                      A strategy with frequent small wins can still lose money.
                      Use profit factor, drawdown, and the average win-to-loss
                      relationship together.
                    </p>
                    {s.lastDecision && (
                      <div className="inset-note">
                        <strong>Latest decision</strong>
                        <p>{s.lastDecision}</p>
                      </div>
                    )}
                  </div>
                </Panel>
              </div>
            </>
          )}
          {tab === "trades" && (
            <Panel
              title="Strategy trade journal"
              aside={<ExportTrades trades={trades} />}
            >
              <div className="filter-bar inside">
                <label className="select-label">
                  Book
                  <select
                    value={book}
                    onChange={(e) => setBook(e.target.value)}
                  >
                    <option value="all">All books</option>
                    <option value="paper">Paper</option>
                    <option value="simulation">Shadow simulation</option>
                  </select>
                </label>
                <label className="select-label">
                  Day (ET)
                  <select
                    value={tradeDay}
                    onChange={(e) => setTradeDay(e.target.value)}
                  >
                    <option value="all">All recorded days</option>
                    {days.map((day) => (
                      <option key={day}>{day}</option>
                    ))}
                  </select>
                </label>
                <span className="subtle">
                  {trades.length} trades · net{" "}
                  <Money value={trades.reduce((v, t) => v + t.netPnl, 0)} />
                </span>
              </div>
              <TradeTable trades={trades} onTrade={onTrade} />
            </Panel>
          )}
          {tab === "rules & levers" && (
            <div className="tuning-grid">
              <Panel title="Trading rules">
                <ol className="rule-list">
                  {(s.rules || []).map((rule, i) => (
                    <li key={i}>
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <p>{rule}</p>
                    </li>
                  ))}
                </ol>
                {!s.rules?.length && (
                  <Empty title="No rule description recorded">
                    Rules must be documented before a candidate can be reviewed.
                  </Empty>
                )}
                <div className="inset-note margin-note">
                  <ShieldCheck size={20} />
                  <p>
                    These rules describe the active version. Changing the
                    candidate controls does not change the running strategy.
                  </p>
                </div>
              </Panel>
              <Panel title="Create a candidate" aside={<GitBranch size={19} />}>
                <form className="parameter-form" onSubmit={submit}>
                  {parameters.map(([key, p]) => (
                    <div className="parameter-field" key={key}>
                      <div>
                        <label htmlFor={`param-${key}`}>
                          {p.label || label(key)}
                        </label>
                        <span className="mono subtle">
                          {p.min} to {p.max}
                        </span>
                      </div>
                      <input
                        id={`param-${key}`}
                        type="number"
                        min={p.min}
                        max={p.max}
                        step={p.step || 0.01}
                        value={values[key] ?? p.value}
                        onChange={(e) =>
                          setValues({
                            ...values,
                            [key]: Number(e.target.value),
                          })
                        }
                        required
                        disabled={p.min === p.max}
                      />
                      {p.description && <p>{p.description}</p>}
                    </div>
                  ))}
                  <label htmlFor="hypothesis">
                    What are you trying to improve?
                  </label>
                  <textarea
                    id="hypothesis"
                    required
                    minLength={10}
                    maxLength={2000}
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Describe the hypothesis and the outcome you expect to change."
                  />
                  {error && (
                    <p className="negative-text" role="alert">
                      {error}
                    </p>
                  )}
                  {result && (
                    <div className="notice success" role="status">
                      <CheckCircle size={20} />
                      <p>{result}</p>
                    </div>
                  )}
                  <button
                    className="button primary"
                    disabled={busy || !parameters.length}
                  >
                    <GitBranch />
                    {busy ? "Saving candidate…" : "Save candidate version"}
                  </button>
                  <p className="small-copy subtle">
                    Candidates require independent validation. Saving does not
                    activate a strategy or place an order.
                  </p>
                </form>
              </Panel>
            </div>
          )}
          {tab === "versions" && (
            <Panel
              title="Version history"
              aside={<span className="subtle">Immutable research records</span>}
            >
              {!s.versions?.length ? (
                <Empty title="No version history yet">
                  Candidate versions appear here when you save a hypothesis.
                </Empty>
              ) : (
                <div className="version-list">
                  {s.versions.map((v) => (
                    <article key={v.id} className="version-item">
                      <div className="version-heading">
                        <span className="version-icon">
                          <GitBranch />
                        </span>
                        <button
                          className="text-button"
                          onClick={() => setCandidateId(v.id)}
                        >
                          Version {v.version}
                          <ArrowRight size={14} />
                        </button>
                        <StateBadge state={v.status} />
                        <time>{dateTime(v.createdAt)} ET</time>
                      </div>
                      <p>{v.notes || "No version notes were recorded."}</p>
                      {Object.keys(versionDiff(v, s)).length > 0 ? (
                        <div className="diff-list">
                          {Object.entries(versionDiff(v, s)).map(
                            ([key, diff]) => (
                              <div key={key}>
                                <span>{label(key)}</span>
                                <del>{diff.from}</del>
                                <ArrowRight size={14} />
                                <ins>{diff.to}</ins>
                              </div>
                            ),
                          )}
                        </div>
                      ) : (
                        v.parameters && (
                          <div className="parameter-chips">
                            {Object.entries(v.parameters).map(
                              ([key, value]) => (
                                <span key={key}>
                                  {label(key)} <b>{value}</b>
                                </span>
                              ),
                            )}
                          </div>
                        )
                      )}
                    </article>
                  ))}
                </div>
              )}
            </Panel>
          )}
          {candidateId && (
            <CandidateReview
              strategyId={id}
              candidateId={candidateId}
              onTrade={onTrade}
              onClose={() => setCandidateId(null)}
              onSaved={() => resource.refresh()}
            />
          )}
        </>
      )}
    </>
  );
}

export function TradesPage({ onTrade }: { onTrade: (trade: Trade) => void }) {
  const r = useResource<Trade[] | { trades: Trade[] }>("/trades", 15000);
  const [query, setQuery] = useState("");
  const [strategy, setStrategy] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [book, setBook] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const all = listOf(r.data, "trades");
  const trades = all.filter((t) => {
    const day = easternDate(t.entryTime);
    return (
      `${t.symbol} ${t.strategyName || t.strategyId} ${t.exitReason}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (strategy === "all" || t.strategyId === strategy) &&
      (outcome === "all" ||
        (outcome === "wins"
          ? t.netPnl > 0
          : outcome === "losses"
            ? t.netPnl < 0
            : t.status === "open")) &&
      (book === "all" || t.source === book) &&
      (!from || day >= from) &&
      (!to || day <= to)
    );
  });
  const net = trades.reduce((s, t) => s + t.netPnl, 0);
  const fees = trades.reduce((s, t) => s + (t.fees || 0), 0);
  return (
    <>
      <Title
        eyebrow="TRADE JOURNAL"
        title="Every trade. Every lesson."
        description="Inspect shadow simulations and paper fills separately. Paper P&L may await broker fee reconciliation."
      >
        <ExportTrades trades={trades} />
      </Title>
      <div className="metrics-strip three">
        <Metric
          label="Filtered trades"
          value={number(trades.length, 0)}
          detail={`${all.length} total records`}
        />
        <Metric
          label="Reported result"
          value={<Money value={net} />}
          detail="Paper fees may be unreconciled"
        />
        <Metric
          label="Execution costs"
          value={money(fees)}
          detail="Sum of recorded fees"
        />
      </div>
      <div className="filter-bar wrap">
        <label className="search-field">
          <MagnifyingGlass />
          <input
            aria-label="Search trades"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Symbol, strategy, or exit reason…"
          />
        </label>
        <select
          aria-label="Filter by strategy"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
        >
          <option value="all">All strategies</option>
          {[
            ...new Map(
              all.map((t) => [t.strategyId, t.strategyName || t.strategyId]),
            ).entries(),
          ].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter trade outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
        >
          <option value="all">All outcomes</option>
          <option value="wins">Winners</option>
          <option value="losses">Losers</option>
          <option value="open">Open</option>
        </select>
        <select
          aria-label="Filter execution book"
          value={book}
          onChange={(e) => setBook(e.target.value)}
        >
          <option value="all">All books</option>
          <option value="paper">Paper</option>
          <option value="simulation">Shadow simulation</option>
        </select>
        <label className="date-filter">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="date-filter">
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      {r.error && <ErrorNotice message={r.error} retry={() => r.refresh()} />}{" "}
      {r.loading ? (
        <Loading />
      ) : (
        <Panel
          title="Execution records"
          aside={
            <span className="subtle">Select a trade for its full details</span>
          }
        >
          <TradeTable trades={trades} onTrade={onTrade} />
        </Panel>
      )}
    </>
  );
}

export function ResearchPage() {
  const [candidateQuery, setCandidateQuery] = useState("");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const r = useResource<Research>("/research", 10000);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const runs = r.data?.runs || [];
  const run = runs.find((item) => item.id === selected) || runs[0];
  const launch = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/research/run", { method: "POST", body: JSON.stringify({}) });
      setMessage(
        "Research run queued. Results will appear as each stage finishes. Active strategies are unchanged.",
      );
      await r.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title
        eyebrow="RESEARCH LAB"
        title="Turn observations into evidence."
        description="Discover, test, validate, and tune. Every decision leaves a record."
      >
        <button
          className="button primary"
          onClick={launch}
          disabled={
            busy ||
            runs.some((run) => ["queued", "running"].includes(run.status))
          }
        >
          <Play weight="fill" />
          {busy ? "Queuing…" : "Run research cycle"}
        </button>
      </Title>
      <div className="research-process">
        {[
          { n: "01", name: "Discover", text: "Bounded hypotheses" },
          { n: "02", name: "Test & train", text: "Chronological samples" },
          { n: "03", name: "Validate", text: "Untouched holdout" },
          { n: "04", name: "Shadow", text: "Observe new sessions" },
          { n: "05", name: "Review", text: "Promote with evidence" },
        ].map((stage, i) => (
          <div key={stage.n}>
            <span className="process-number">{stage.n}</span>
            <strong>{stage.name}</strong>
            <small>{stage.text}</small>
            {i < 4 && <ArrowRight size={15} />}
          </div>
        ))}
      </div>
      <div className="notice neutral">
        <ShieldCheck size={20} />
        <div>
          <strong>Improvement is measured, not assumed.</strong>
          <p>
            A cycle can finish without accepting a candidate. Rejections and
            insufficient samples remain visible.{" "}
            {typeof r.data?.schedule === "string"
              ? `Schedule: ${r.data.schedule}.`
              : ""}
          </p>
        </div>
      </div>
      {r.error && <ErrorNotice message={r.error} retry={() => r.refresh()} />}{" "}
      {error && <ErrorNotice message={error} />}{" "}
      {message && (
        <div className="notice success" role="status">
          <CheckCircle size={20} />
          <p>{message}</p>
        </div>
      )}
      {r.loading ? (
        <Loading />
      ) : !runs.length ? (
        <Panel title="Research runs">
          <Empty title="Your first research cycle starts here">
            Collect real sessions, then run a cycle to test candidate hypotheses
            against holdout evidence.
          </Empty>
        </Panel>
      ) : (
        <div className="research-layout">
          <Panel
            title="Run history"
            aside={
              <button
                className="icon-button"
                aria-label="Refresh research runs"
                onClick={() => r.refresh()}
              >
                <ArrowClockwise />
              </button>
            }
          >
            <div className="run-list">
              {runs.map((item) => (
                <button
                  key={item.id}
                  className={run?.id === item.id ? "active" : ""}
                  onClick={() => setSelected(item.id)}
                >
                  <div>
                    <strong>{dateTime(item.startedAt)}</strong>
                    <StateBadge state={item.status} />
                  </div>
                  <span>
                    {item.candidates ?? item.results?.length ?? 0} candidates ·{" "}
                    {item.accepted ?? 0} queued for shadow
                  </span>
                  <small>{item.id}</small>
                </button>
              ))}
            </div>
          </Panel>
          {run && (
            <div className="research-run">
              <Panel
                title="Cycle report"
                aside={<StateBadge state={run.status} />}
              >
                <div className="run-summary">
                  <span className="subtle">{run.id}</span>
                  <h3>
                    {run.summary ||
                      "Evidence is being collected for this cycle."}
                  </h3>
                  <div className="run-metrics">
                    <div>
                      <strong>
                        {run.candidates ?? run.results?.length ?? 0}
                      </strong>
                      <span>Candidates</span>
                    </div>
                    <div>
                      <strong className="positive-text">
                        {run.accepted ?? 0}
                      </strong>
                      <span>Queued for shadow</span>
                    </div>
                    <div>
                      <strong>{run.rejected ?? 0}</strong>
                      <span>Rejected</span>
                    </div>
                  </div>
                </div>
                <div className="stage-list">
                  {(run.stages || []).map((stage, i) => (
                    <div key={i}>
                      <span className="stage-index">{i + 1}</span>
                      <div>
                        <strong>{stage.name}</strong>
                        <p>
                          {stage.detail ||
                            "No additional stage detail recorded."}
                        </p>
                      </div>
                      <StateBadge state={stage.status} />
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel
                title="Candidate decisions"
                aside={
                  <span className="subtle">
                    Scores are out-of-sample where labelled
                  </span>
                }
              >
                {!run.results?.length ? (
                  <Empty title="No candidate results yet">
                    This run will publish a decision for every hypothesis it
                    evaluates.
                  </Empty>
                ) : (
                  <div>
                    <div className="filter-bar inside">
                      <label className="search-field">
                        <MagnifyingGlass />
                        <input
                          aria-label="Filter research candidates"
                          placeholder="Filter by strategy…"
                          value={candidateQuery}
                          onChange={(e) => setCandidateQuery(e.target.value)}
                        />
                      </label>
                      <select
                        aria-label="Filter candidate decision"
                        value={decisionFilter}
                        onChange={(e) => setDecisionFilter(e.target.value)}
                      >
                        <option value="all">All decisions</option>
                        {[
                          ...new Set(
                            run.results.map((result) => result.decision),
                          ),
                        ].map((decision) => (
                          <option key={decision} value={decision}>
                            {label(decision)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="candidate-list">
                      {run.results
                        .filter(
                          (result) =>
                            result.name
                              .toLowerCase()
                              .includes(candidateQuery.toLowerCase()) &&
                            (decisionFilter === "all" ||
                              result.decision === decisionFilter),
                        )
                        .map((result, i) => (
                          <article key={i}>
                            <div>
                              <h3>{result.name}</h3>
                              <StateBadge state={result.decision} />
                            </div>
                            <p>{explainGate(result.reason)}</p>
                            <dl>
                              <div>
                                <dt>Train</dt>
                                <dd>{number(result.trainScore)}</dd>
                              </div>
                              <div>
                                <dt>Validation</dt>
                                <dd>{number(result.validationScore)}</dd>
                              </div>
                              <div>
                                <dt>Holdout</dt>
                                <dd>{number(result.holdoutScore)}</dd>
                              </div>
                              <div>
                                <dt>Sample</dt>
                                <dd>{number(result.sampleSize, 0)}</dd>
                              </div>
                            </dl>
                            {result.parameters && (
                              <details>
                                <summary>Candidate parameters</summary>
                                <div className="parameter-chips">
                                  {Object.entries(result.parameters).map(
                                    ([key, value]) => (
                                      <span key={key}>
                                        {label(key)} <b>{value}</b>
                                      </span>
                                    ),
                                  )}
                                </div>
                              </details>
                            )}
                          </article>
                        ))}
                    </div>
                  </div>
                )}
              </Panel>
            </div>
          )}
        </div>
      )}
      {r.data?.policy && (
        <Panel title="Promotion policy">
          <div className="prose-block">
            {typeof r.data.policy === "string" ? (
              <p>{r.data.policy}</p>
            ) : (
              <dl className="definition-list">
                {Object.entries(r.data.policy).map(([key, value]) => (
                  <div key={key}>
                    <dt>{label(key)}</dt>
                    <dd>
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}

export function SystemPage({
  overview,
  stream,
}: {
  overview: Overview;
  stream: string;
}) {
  const r = useResource<Record<string, unknown>>("/system", 15000);
  return (
    <>
      <Title
        eyebrow="SYSTEM HEALTH"
        title="See why the engine is waiting."
        description="Connection status, risk gates, and research readiness in one place."
      >
        <button className="button secondary" onClick={() => r.refresh()}>
          <ArrowClockwise />
          Refresh status
        </button>
      </Title>
      <div className="metrics-strip three">
        <Metric
          label="Execution engine"
          value={<StateBadge state={overview.engine.state} />}
          detail={overview.engine.session}
        />
        <Metric
          label="Market data feed"
          value={<StateBadge state={overview.feed.state} />}
          detail={overview.feed.feed || "Not configured"}
        />
        <Metric
          label="Dashboard events"
          value={<StateBadge state={stream} />}
          detail="Same-origin server stream"
        />
      </div>
      <div className="detail-grid">
        <Panel title="Execution gate" aside={<ShieldCheck size={20} />}>
          <div className="prose-block">
            <h3>{label(overview.engine.state)}</h3>
            <p>
              {overview.engine.reason ||
                "No active execution gate has been reported."}
            </p>
            <dl className="definition-list">
              <div>
                <dt>Daily loss limit</dt>
                <dd>{number(overview.risk.dailyLossLimitPct)}%</dd>
              </div>
              <div>
                <dt>Current daily loss</dt>
                <dd>{number(overview.risk.lossUsedPct)}%</dd>
              </div>
              <div>
                <dt>Last heartbeat</dt>
                <dd>{dateTime(overview.engine.lastHeartbeat)} ET</dd>
              </div>
              <div>
                <dt>Shadow observations</dt>
                <dd>{overview.engine.shadowActive ? "Continuing" : "Idle"}</dd>
              </div>
            </dl>
          </div>
        </Panel>
        <Panel
          title="Market data connection"
          aside={<WarningCircle size={20} />}
        >
          <div className="prose-block">
            <h3>{overview.feed.feed || "Awaiting provider configuration"}</h3>
            <p>
              {overview.feed.error ||
                overview.feed.reason ||
                "Provider status is reported by the server. Every browser shares the server connection."}
            </p>
            <dl className="definition-list">
              <div>
                <dt>State</dt>
                <dd>{label(overview.feed.state)}</dd>
              </div>
              <div>
                <dt>Last market event</dt>
                <dd>{dateTime(overview.feed.lastEventAt)} ET</dd>
              </div>
              <div>
                <dt>Credential location</dt>
                <dd>Server environment only</dd>
              </div>
              <div>
                <dt>Browser transport</dt>
                <dd>Authenticated SSE</dd>
              </div>
            </dl>
          </div>
        </Panel>
      </div>
      {r.error && <ErrorNotice message={r.error} retry={() => r.refresh()} />}{" "}
      {r.data && (
        <Panel
          title="Service diagnostics"
          aside={<span className="subtle">Reported by the API</span>}
        >
          <div className="diagnostics">
            {Object.entries(r.data).map(([key, value]) => (
              <details key={key} open={typeof value !== "object"}>
                <summary>{label(key)}</summary>
                {typeof value === "object" ? (
                  <pre>{JSON.stringify(value, null, 2)}</pre>
                ) : (
                  <p>{String(value)}</p>
                )}
              </details>
            ))}
          </div>
        </Panel>
      )}
      <div className="inset-note inline-note">
        <Flask size={23} />
        <div>
          <h3>Execution and research have separate jobs.</h3>
          <p>
            When the paper book reaches its daily loss limit, new entries stop
            for the session. The shadow book can continue collecting outcomes,
            and the nightly research cycle can still evaluate candidates. A
            dashboard button cannot bypass the loss limit.
          </p>
        </div>
      </div>
    </>
  );
}

interface CandidateEvidence {
  id: string;
  version: string;
  status: string;
  parameters: Record<string, number>;
  trades: Trade[];
  metrics: Metrics;
  sessions: number;
  promotion: { eligible: boolean; reasons: string[]; policy?: unknown };
}
function CandidateReview({
  strategyId,
  candidateId,
  onTrade,
  onClose,
  onSaved,
}: {
  strategyId: string;
  candidateId: string;
  onTrade: (t: Trade) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const path = `/strategies/${encodeURIComponent(strategyId)}/candidates/${encodeURIComponent(candidateId)}`;
  const r = useResource<CandidateEvidence>(path);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const approve = async () => {
    if (!r.data?.promotion.eligible || !ack) return;
    setBusy(true);
    try {
      await api(`${path}/approve`, {
        method: "POST",
        body: JSON.stringify({
          version: r.data.version,
          acknowledgePaperRisk: true,
        }),
      });
      setMessage(
        "This exact candidate version is approved for paper execution. Account-level risk gates still apply.",
      );
      onSaved();
      await r.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Candidate evidence"
      eyebrow="Version review"
      onClose={onClose}
      wide
    >
      {r.error && <ErrorNotice message={r.error} retry={() => r.refresh()} />}{" "}
      {r.loading ? (
        <Loading />
      ) : r.data ? (
        <>
          <div className="detail-topline">
            <Badge>Version {r.data.version}</Badge>
            <StateBadge state={r.data.status} />
          </div>
          <div className="metrics-strip three">
            <Metric
              label="Shadow trades"
              value={number(r.data.metrics?.trades ?? r.data.trades?.length, 0)}
            />
            <Metric
              label="Observed sessions"
              value={number(r.data.sessions, 0)}
            />
            <Metric
              label="Net modeled P&L"
              value={<Money value={r.data.metrics?.netPnl} />}
            />
          </div>
          <div
            className={`notice ${r.data.promotion.eligible ? "success" : "warning"}`}
          >
            <ShieldCheck size={21} />
            <div>
              <strong>
                {r.data.promotion.eligible
                  ? "Eligible for paper review"
                  : "Not eligible for paper execution"}
              </strong>
              {(r.data.promotion.reasons || []).map((reason, i) => (
                <p key={i}>{reason}</p>
              ))}
            </div>
          </div>
          <div className="parameter-chips">
            {Object.entries(r.data.parameters || {}).map(([key, value]) => (
              <span key={key}>
                {label(key)} <b>{value}</b>
              </span>
            ))}
          </div>
          <h3 className="candidate-trades-title">Forward shadow trades</h3>
          <TradeTable trades={r.data.trades || []} onTrade={onTrade} />
          {r.data.promotion.eligible && (
            <div className="approval-box">
              <label className="check">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                I reviewed this exact version and authorize paper orders under
                the account risk limits.
              </label>
              <button
                className="button primary"
                disabled={!ack || busy}
                onClick={approve}
              >
                {busy ? "Approving…" : "Approve this version for paper"}
              </button>
            </div>
          )}
          {message && (
            <div className="notice success" role="status">
              <p>{message}</p>
            </div>
          )}
          {error && <ErrorNotice message={error} />}
        </>
      ) : null}
    </Modal>
  );
}
