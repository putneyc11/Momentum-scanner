import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Pulse as Activity,
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  ChartLineUp,
  ChartPieSlice,
  Flask,
  Heartbeat,
  List,
  Pause,
  Play,
  ShieldCheck,
  SignOut,
  SlidersHorizontal,
  Stack,
  TrendUp,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api, ApiError, setCsrfToken, useEvents, useResource } from "./api";
import type { Overview, Session, Strategy, Trade } from "./types";
import { dateTime, label, money, number, signed } from "./format";
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  Metric,
  Money,
  Panel,
  StateBadge,
  TradeModal,
  TradeTable,
} from "./ui";
import Chart from "./Chart";
import {
  StrategyDetail,
  StrategiesPage,
  TradesPage,
  ResearchPage,
  SystemPage,
} from "./Pages";
import ScannerPage from "./Scanner";

const navigation = [
  { path: "/", label: "Overview", icon: ChartPieSlice },
  { path: "/strategies", label: "Strategies", icon: Stack },
  { path: "/research", label: "Research lab", icon: Flask },
  { path: "/trades", label: "Trade journal", icon: Activity },
  { path: "/system", label: "System health", icon: Heartbeat },
];
function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = useCallback((next: string) => {
    window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  return { path, navigate };
}

export default function App() {
  const session = useResource<Session>("/session");
  const { path, navigate } = useRoute();
  const [menu, setMenu] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  useEffect(() => {
    if (session.data) setCsrfToken(session.data.csrfToken);
  }, [session.data]);
  useEffect(() => {
    const expire = () => {
      session.setData((previous) =>
        previous ? { ...previous, authenticated: false } : previous,
      );
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, [session.setData]);
  const authenticated = Boolean(session.data?.authenticated);
  const isAdmin = session.data?.role === "admin";
  const overview = useResource<Overview>(
    authenticated && isAdmin ? "/overview" : null,
    15000,
  );
  const stream = useEvents(authenticated, (events) => {
    window.dispatchEvent(
      new CustomEvent("momentum-stream", { detail: events }),
    );
    if (isAdmin && events.some((event) => event.name === "research"))
      void overview.refresh();
  });

  useEffect(() => {
    if (
      authenticated &&
      ((!isAdmin && !path.startsWith("/scanner")) ||
        (session.data?.product === "scanner" && path === "/"))
    )
      navigate("/scanner");
  }, [authenticated, isAdmin, path, navigate, session.data?.product]);
  if (session.loading)
    return (
      <div className="boot">
        <div className="brand-symbol">
          <TrendUp size={26} />
        </div>
        <p>Opening your workspace…</p>
      </div>
    );
  if (!authenticated)
    return <Login onSuccess={() => session.refresh()} error={session.error} />;
  const mode = session.data?.mode || "unconfigured";
  const scanner = path.startsWith("/scanner");
  const section = scanner
    ? "Market scanner"
    : navigation.find((n) =>
        n.path === "/" ? path === "/" : path.startsWith(n.path),
      )?.label || "Overview";
  const go = (p: string) => {
    navigate(p);
    setMenu(false);
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            go("/");
          }}
          className="brand"
        >
          <span className="brand-symbol">
            <TrendUp size={25} weight="bold" />
          </span>
          <div>
            momentum<span>RESEARCH & EXECUTION</span>
          </div>
        </a>
        <button
          className="mobile-close icon-button"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        >
          <X />
        </button>
        <div className="workspace-switch">
          <span className="workspace-avatar">M</span>
          <div>
            <strong>{scanner ? "Momentum Scanner" : "Algo Trader"}</strong>
            <small>Personal workspace</small>
          </div>
          <SlidersHorizontal size={17} />
        </div>
        {isAdmin && <div className="nav-label">WORKSPACE</div>}
        <nav aria-label="Main navigation">
          {(isAdmin ? navigation : []).map((n) => (
            <a
              href={n.path}
              key={n.path}
              aria-current={
                n.path === "/"
                  ? path === "/"
                    ? "page"
                    : undefined
                  : path.startsWith(n.path)
                    ? "page"
                    : undefined
              }
              className={
                (n.path === "/" ? path === "/" : path.startsWith(n.path))
                  ? "active"
                  : ""
              }
              onClick={(e) => {
                e.preventDefault();
                go(n.path);
              }}
            >
              <n.icon size={20} />
              {n.label}
              {n.path === "/strategies" && overview.data && (
                <span className="nav-count">
                  {overview.data.strategies.length}
                </span>
              )}
            </a>
          ))}
        </nav>
        {isAdmin && <div className="nav-divider" />}
        <div className="nav-label">MARKET TOOLS</div>
        <nav>
          <a
            className={scanner ? "active" : ""}
            href="/scanner"
            onClick={(e) => {
              e.preventDefault();
              go("/scanner");
            }}
            aria-current={scanner ? "page" : undefined}
          >
            <ChartLineUp size={20} />
            Momentum scanner
            <ArrowSquareOut size={14} className="trailing" />
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="execution-note">
            <ShieldCheck size={22} />
            <strong>
              {isAdmin ? "Paper execution only" : "Market data only"}
            </strong>
            <p>
              {isAdmin
                ? "Strategies earn their allocation through recorded evidence."
                : "Your session can view market data without access to trading controls."}
            </p>
          </div>
          <div className="user-row">
            <div className="user-avatar">CP</div>
            <div>
              <strong>{isAdmin ? "Workspace owner" : "Scanner viewer"}</strong>
              <small>
                {mode === "demo" ? "Demo environment" : "Private session"}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={async () => {
                try {
                  await api("/auth/logout", { method: "POST" });
                  session.setData((previous) =>
                    previous ? { ...previous, authenticated: false } : previous,
                  );
                } catch (e) {
                  window.alert((e as Error).message);
                }
              }}
            >
              <SignOut size={19} />
            </button>
          </div>
        </div>
      </aside>
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <List />
            </button>
            <span>{scanner ? "Scanner" : "Algo Trader"}</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{section}</strong>
          </div>
          <div className="header-status">
            <Badge tone={mode === "demo" ? "warning" : "neutral"}>
              {mode === "demo" ? "DEMO DATA" : mode.toUpperCase()}
            </Badge>
            <span className="connection-label">
              <span
                className={`status-dot ${stream === "connected" ? "online" : "offline"}`}
              />
              {stream === "connected" ? "Workspace connected" : "Reconnecting"}
            </span>
            <span className="header-date">
              {new Date().toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                timeZone: "America/New_York",
              })}
            </span>
          </div>
        </header>
        <main id="main-content">
          <div className="content-wrap">
            {mode === "demo" && (
              <div className="demo-banner">
                <Flask size={17} />
                <span>
                  <strong>Demo workspace.</strong> All account, strategy, trade,
                  and scanner records are deterministic examples. No orders are
                  sent.
                </span>
                {isAdmin && (
                  <button onClick={() => go("/system")}>
                    Connect your data
                    <ArrowRight size={14} />
                  </button>
                )}
              </div>
            )}
            {overview.error && (
              <ErrorNotice
                message={overview.error}
                retry={() => overview.refresh()}
              />
            )}
            {scanner || !isAdmin ? (
              <ScannerPage mode={mode} />
            ) : overview.loading ? (
              <Loading />
            ) : !overview.data ? (
              <Empty title="Workspace data is unavailable">
                Check the API connection and use Retry above.
              </Empty>
            ) : path.startsWith("/strategies/") ? (
              <StrategyDetail
                id={decodeURIComponent(path.split("/")[2])}
                onBack={() => go("/strategies")}
                onTrade={setSelectedTrade}
              />
            ) : path === "/strategies" ? (
              <StrategiesPage navigate={go} />
            ) : path === "/trades" ? (
              <TradesPage onTrade={setSelectedTrade} />
            ) : path === "/research" ? (
              <ResearchPage />
            ) : path === "/system" ? (
              <SystemPage overview={overview.data} stream={stream} />
            ) : (
              <OverviewPage
                data={overview.data}
                navigate={go}
                onTrade={setSelectedTrade}
                refresh={() => overview.refresh()}
                refreshing={overview.refreshing}
              />
            )}
            <footer className="workspace-footer">
              <span>
                <ShieldCheck size={14} /> Credentials stay on the server
              </span>
              <span>
                Paper results are not live execution results · Times shown in ET
              </span>
            </footer>
          </div>
        </main>
      </div>
      {selectedTrade && (
        <TradeModal
          trade={selectedTrade}
          onClose={() => setSelectedTrade(null)}
        />
      )}
    </div>
  );
}

function Login({ onSuccess, error }: { onSuccess: () => void; error: string }) {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState(error);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await api<Session>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setCsrfToken(result.csrfToken);
      setToken("");
      onSuccess();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-form">
        <a href="/" className="brand">
          <span className="brand-symbol">
            <TrendUp size={25} />
          </span>
          <div>
            momentum<span>RESEARCH & EXECUTION</span>
          </div>
        </a>
        <div className="login-copy">
          <Badge tone="neutral">Private workspace</Badge>
          <h1>
            Your edge starts
            <br />
            with evidence.
          </h1>
          <p>
            Sign in to inspect strategies, review every trade, and manage your
            research cycle.
          </p>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="token">Workspace access token</label>
          <input
            id="token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            placeholder="Enter your dashboard token"
          />
          {message && (
            <p role="alert" className="negative-text">
              {message}
            </p>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? "Signing in…" : "Open workspace"}
            <ArrowRight />
          </button>
        </form>
        <p className="subtle small-copy">
          Use your ADMIN_TOKEN from Render. This is separate from your Alpaca
          API key. Your session uses a secure HTTP-only cookie.
        </p>
      </div>
    </div>
  );
}

function OverviewPage({
  data: d,
  navigate,
  onTrade,
  refresh,
  refreshing,
}: {
  data: Overview;
  navigate: (p: string) => void;
  onTrade: (t: Trade) => void;
  refresh: () => void;
  refreshing: boolean;
}) {
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const isHalted = /halt|blocked|error/.test(d.engine.state);
  const isPaused = /pause/.test(d.engine.state);
  const heartbeatStale =
    d.engine.lastHeartbeat &&
    Date.now() - Date.parse(d.engine.lastHeartbeat) > 90000 &&
    d.mode !== "demo";
  const action = async () => {
    setActionBusy(true);
    setActionError("");
    try {
      await api(`/engine/${isPaused ? "resume" : "pause"}`, { method: "POST" });
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  };
  const totals = d.strategies.reduce(
    (acc, s) => ({
      trades: acc.trades + (s.metrics?.trades || 0),
      wins:
        acc.wins + ((s.metrics?.trades || 0) * (s.metrics?.winRate || 0)) / 100,
    }),
    { trades: 0, wins: 0 },
  );
  const top = [...d.strategies].sort(
    (a, b) => (b.metrics?.netPnl || 0) - (a.metrics?.netPnl || 0),
  )[0];
  const usage = Math.min(
    100,
    Math.max(
      0,
      (d.risk.lossUsedPct / Math.max(0.01, d.risk.dailyLossLimitPct)) * 100,
    ),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PORTFOLIO OVERVIEW</div>
          <h1>The full picture.</h1>
          <p>Track the book. Understand the decisions. Improve the process.</p>
        </div>
        <div className="page-actions">
          <button
            className="button secondary"
            onClick={refresh}
            disabled={refreshing}
          >
            <ArrowClockwise className={refreshing ? "refreshing" : ""} />
            Refresh
          </button>
          <button
            className="button secondary"
            onClick={action}
            disabled={actionBusy || isHalted}
          >
            {isPaused ? <Play /> : <Pause />}
            {isPaused ? "Resume entries" : "Pause entries"}
          </button>
        </div>
      </div>
      {(isHalted || isPaused || heartbeatStale) && (
        <div className={`notice ${isHalted ? "error" : "warning"}`}>
          <WarningCircle size={23} />
          <div>
            <strong>
              {heartbeatStale
                ? "Engine heartbeat is stale"
                : isHalted
                  ? "New entries are halted"
                  : "New entries are paused"}
            </strong>
            <p>
              {heartbeatStale
                ? "The service has not reported a recent heartbeat. Inspect System health before resuming."
                : d.engine.reason ||
                  "Inspect the engine status for the reason."}{" "}
              {d.engine.shadowActive
                ? "Shadow research continues collecting evidence."
                : ""}
            </p>
          </div>
          <button className="text-button" onClick={() => navigate("/system")}>
            Inspect status
            <ArrowRight />
          </button>
        </div>
      )}
      {actionError && <ErrorNotice message={actionError} />}
      <div className="metrics-strip">
        <Metric
          label="Account equity"
          value={money(d.account.equity)}
          detail={
            <>
              <span className="micro-dot" />
              Paper account
            </>
          }
        />
        <Metric
          label="Day P&L"
          value={signed(d.account.dayPnl)}
          tone={d.account.dayPnl >= 0 ? "positive-text" : "negative-text"}
          detail={`${signed(d.account.dayPnlPct, "percent")} from previous close`}
        />
        <Metric
          label="Shadow trades"
          value={number(totals.trades, 0)}
          detail={`${number(totals.trades ? (totals.wins / totals.trades) * 100 : 0, 1)}% win rate · shadow simulations`}
        />
        <Metric
          label="Open positions"
          value={
            <>
              {d.account.openPositions}
              <span className="metric-denominator">
                {" "}
                / {d.risk.maxPositions}
              </span>
            </>
          }
          detail={`${money(d.account.buyingPower)} buying power`}
        />
      </div>
      <div className="overview-chart-grid">
        <Chart points={d.equity} trades={d.recentTrades} onTrade={onTrade} />
        <div className="overview-rail">
          <Panel title="Execution status">
            <div className="status-content">
              <div className="state-line">
                <span>Paper engine</span>
                <StateBadge state={d.engine.state} />
              </div>
              <div className="state-line">
                <span>Session</span>
                <strong>{label(d.engine.session)}</strong>
              </div>
              <div className="state-line">
                <span>Market data</span>
                <StateBadge state={d.feed.state} />
              </div>
              <div className="state-line">
                <span>Research observation</span>
                <strong>{d.engine.shadowActive ? "Collecting" : "Idle"}</strong>
              </div>
              <div className="timestamp">
                Last heartbeat{" "}
                <span>{dateTime(d.engine.lastHeartbeat)} ET</span>
              </div>
            </div>
          </Panel>
          <Panel
            title="Risk budget"
            aside={<ShieldCheck size={17} className="muted" />}
          >
            <div className="risk-content">
              <div className="risk-amount">
                <strong>
                  {number(usage, 0)}
                  <small>%</small>
                </strong>
                <span>
                  of daily loss
                  <br />
                  limit used
                </span>
              </div>
              <div
                className="risk-meter"
                role="meter"
                aria-label="Daily loss limit used"
                aria-valuenow={usage}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <i
                  style={{ width: `${usage}%` }}
                  className={usage >= 100 ? "danger" : ""}
                />
              </div>
              <div className="risk-settings">
                <span>
                  Daily stop <b>{number(d.risk.dailyLossLimitPct, 1)}%</b>
                </span>
                <span>
                  Risk per trade <b>{number(d.risk.riskPerTradePct, 2)}%</b>
                </span>
              </div>
              <p>
                Risk stops remain locked for the session. Research does not
                share the execution stop.
              </p>
            </div>
          </Panel>
        </div>
      </div>
      <div className="section-title">
        <div>
          <h2>Baseline shadow performance</h2>
          <p>
            Simulated strategy outcomes are separate from the paper account
            above.
          </p>
        </div>
        <button className="text-button" onClick={() => navigate("/strategies")}>
          Explore strategies
          <ArrowRight />
        </button>
      </div>
      <StrategyTable strategies={d.strategies} navigate={navigate} />
      <div className="overview-bottom">
        <Panel
          title="Recent activity"
          aside={
            <button className="text-button" onClick={() => navigate("/trades")}>
              Trade journal
              <ArrowRight />
            </button>
          }
        >
          <TradeTable trades={d.recentTrades} onTrade={onTrade} limit={5} />
        </Panel>
        <Panel title="Research focus">
          <div className="research-focus">
            <div className="focus-icon">
              <Flask size={23} />
            </div>
            <h3>
              Make the next version
              <br />
              earn its place.
            </h3>
            <p>
              {top
                ? `${top.name} leads this snapshot at ${signed(top.metrics.netPnl)}. Inspect sample size and holdout evidence before changing its allocation.`
                : "Collect trade evidence before allocating risk to a strategy."}
            </p>
            <button
              className="button secondary"
              onClick={() => navigate("/research")}
            >
              Open research lab
              <ArrowRight />
            </button>
          </div>
        </Panel>
      </div>
    </>
  );
}

export function StrategyTable({
  strategies,
  navigate,
}: {
  strategies: Strategy[];
  navigate: (p: string) => void;
}) {
  if (!strategies.length)
    return (
      <Panel title="Strategies">
        <Empty title="No strategies configured">
          Create or import a research candidate to start collecting evidence.
        </Empty>
      </Panel>
    );
  return (
    <div className="panel table-scroll strategy-table">
      <table>
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Status</th>
            <th className="numeric">Trades</th>
            <th className="numeric">Win rate</th>
            <th className="numeric">Profit factor</th>
            <th className="numeric">Expectancy</th>
            <th className="numeric">Net P&L</th>
            <th className="numeric">Max drawdown</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {strategies.map((s, i) => (
            <tr key={s.id}>
              <td>
                <button
                  className="strategy-name"
                  onClick={() => navigate(`/strategies/${s.id}`)}
                >
                  <span className="strategy-glyph">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{s.name}</strong>
                    <small>
                      {s.family || "Momentum"} <span>· v{s.version}</span>
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <StateBadge state={s.status} />
              </td>
              <td className="numeric mono">{number(s.metrics.trades, 0)}</td>
              <td className="numeric mono">
                {number(s.metrics.winRate, 1)}
                <span className="muted">%</span>
              </td>
              <td className="numeric mono">{number(s.metrics.profitFactor)}</td>
              <td className="numeric">
                <Money value={s.metrics.expectancy} />
              </td>
              <td className="numeric">
                <Money value={s.metrics.netPnl} />
              </td>
              <td className="numeric mono">{money(s.metrics.maxDrawdown)}</td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`Open ${s.name}`}
                  onClick={() => navigate(`/strategies/${s.id}`)}
                >
                  <ArrowRight />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
