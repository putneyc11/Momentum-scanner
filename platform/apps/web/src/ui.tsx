import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowClockwise,
  WarningCircle,
  X,
  ArrowUpRight,
} from "@phosphor-icons/react";
import { label, money, number, signed, dateTime, exportCsv } from "./format";
import type { Trade } from "./types";
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
export function StateBadge({ state }: { state: string }) {
  const s = (state || "unknown").toLowerCase();
  return (
    <Badge
      tone={
        /active|running|connected|passed|accepted|healthy|complete/.test(s)
          ? "positive"
          : /halt|error|fail|reject|stale|disconnected/.test(s)
            ? "negative"
            : /demo|pending|shadow|candidate|pause|wait|reconnect/.test(s)
              ? "warning"
              : "neutral"
      }
    >
      {label(state || "unknown")}
    </Badge>
  );
}
export function Money({ value }: { value: number | null | undefined }) {
  return (
    <span
      className={`mono ${value === null || value === undefined ? "" : value > 0 ? "positive-text" : value < 0 ? "negative-text" : ""}`}
    >
      {signed(value)}
    </span>
  );
}
export function Metric({
  label: caption,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="metric">
      <span className="metric-label">{caption}</span>
      <strong className={tone || ""}>{value}</strong>
      {detail && <span className="metric-detail">{detail}</span>}
    </div>
  );
}
export function Panel({
  title,
  aside,
  children,
  className = "",
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
export function Empty({
  title = "Nothing here yet",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function ErrorNotice({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="notice error" role="alert">
      <WarningCircle size={20} />
      <div>
        <strong>Connection needs attention</strong>
        <p>{message}</p>
      </div>
      {retry && (
        <button className="button secondary small" onClick={retry}>
          <ArrowClockwise />
          Retry
        </button>
      )}
    </div>
  );
}
export function Loading() {
  return (
    <div
      className="loading-layout"
      aria-label="Loading workspace"
      role="status"
    >
      <div className="skeleton title" />
      <div className="skeleton metrics" />
      <div className="skeleton chart" />
      <div className="skeleton table" />
      <span className="sr-only">Loading data</span>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  eyebrow = "Trade inspection",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  eyebrow?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close details"
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function TradeModal({
  trade,
  onClose,
}: {
  trade: Trade;
  onClose: () => void;
}) {
  const t = trade;
  return (
    <Modal
      title={`${t.symbol} · ${t.strategyName || t.strategyId}`}
      onClose={onClose}
      wide
    >
      <div className="detail-topline">
        <StateBadge state={t.status} />
        <span className="subtle">
          {t.side} · Trade {t.id}
        </span>
      </div>
      <div className="metrics-strip three">
        <Metric
          label={t.source === "paper" ? "Reported result" : "Net result"}
          value={<Money value={t.netPnl} />}
          detail={
            t.source === "paper"
              ? "Broker fees may await reconciliation"
              : "After modeled costs"
          }
        />
        <Metric
          label="Return on risk"
          value={`${number(t.rMultiple)} R`}
          detail="Result / initial risk"
        />
        <Metric
          label="Quantity"
          value={number(t.quantity, 0)}
          detail="Shares"
        />
      </div>
      <div className="detail-grid">
        <dl className="definition-list">
          <div>
            <dt>Entry time (ET)</dt>
            <dd>{dateTime(t.entryTime)}</dd>
          </div>
          <div>
            <dt>Entry price</dt>
            <dd>{money(t.entryPrice)}</dd>
          </div>
          <div>
            <dt>Exit time (ET)</dt>
            <dd>{dateTime(t.exitTime)}</dd>
          </div>
          <div>
            <dt>Exit price</dt>
            <dd>{money(t.exitPrice)}</dd>
          </div>
          <div>
            <dt>Return</dt>
            <dd>{signed(t.pnlPct, "percent")}</dd>
          </div>
        </dl>
        <dl className="definition-list">
          <div>
            <dt>Maximum favorable excursion</dt>
            <dd>{money(t.mfe)}</dd>
          </div>
          <div>
            <dt>Maximum adverse excursion</dt>
            <dd>{money(t.mae)}</dd>
          </div>
          <div>
            <dt>
              {t.source === "paper"
                ? "Fees (pending statement)"
                : "Modeled fees"}
            </dt>
            <dd>{t.source === "paper" ? "Not reconciled" : money(t.fees)}</dd>
          </div>
          <div>
            <dt>Exit reason</dt>
            <dd>{label(t.exitReason || "Position open")}</dd>
          </div>
          <div>
            <dt>Execution mode</dt>
            <dd>
              {t.source === "paper"
                ? "Paper broker fills"
                : t.source === "simulation"
                  ? "Shadow simulation"
                  : "Not recorded"}
            </dd>
          </div>
        </dl>
      </div>
      <div className="inset-note">
        <h3>Why this trade happened</h3>
        <p>
          {t.entryReason || "Entry rationale was not recorded for this trade."}
        </p>
      </div>
      <p className="subtle small-copy">
        MFE and MAE describe the largest favorable and adverse position-value
        changes, in dollars, during the position. Unavailable measurements are
        shown as a dash, never inferred.
      </p>
    </Modal>
  );
}
export function TradeTable({
  trades,
  onTrade,
  limit,
}: {
  trades: Trade[];
  onTrade: (trade: Trade) => void;
  limit?: number;
}) {
  if (!trades.length)
    return (
      <Empty title="No trades match this view">
        Adjust the filters or wait for the next recorded trade.
      </Empty>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Symbol / strategy</th>
            <th>Entry · ET</th>
            <th>Side</th>
            <th className="numeric">Qty</th>
            <th className="numeric">Entry</th>
            <th className="numeric">Exit</th>
            <th className="numeric">Reported P&L</th>
            <th className="numeric">R</th>
            <th>Exit / status</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {trades.slice(0, limit).map((t) => (
            <tr key={t.id}>
              <td>
                <button className="cell-button" onClick={() => onTrade(t)}>
                  <strong>{t.symbol}</strong>
                  <small>
                    {t.strategyName || label(t.strategyId)} ·{" "}
                    {t.source === "simulation"
                      ? "shadow"
                      : t.source || "unknown book"}
                  </small>
                </button>
              </td>
              <td className="mono muted">{dateTime(t.entryTime)}</td>
              <td>{t.side}</td>
              <td className="numeric mono">{number(t.quantity, 0)}</td>
              <td className="numeric mono">{money(t.entryPrice)}</td>
              <td className="numeric mono">{money(t.exitPrice)}</td>
              <td className="numeric">
                <Money value={t.netPnl} />
              </td>
              <td className="numeric mono">{number(t.rMultiple)}</td>
              <td>
                <span className="subtle">
                  {label(t.exitReason || t.status)}
                </span>
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`Inspect ${t.symbol} trade ${t.id}`}
                  onClick={() => onTrade(t)}
                >
                  <ArrowUpRight />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function ExportTrades({ trades }: { trades: Trade[] }) {
  return (
    <button
      className="button secondary small"
      disabled={!trades.length}
      onClick={() =>
        exportCsv(
          trades as unknown as Record<string, unknown>[],
          "momentum-trades.csv",
        )
      }
    >
      Export CSV
    </button>
  );
}
