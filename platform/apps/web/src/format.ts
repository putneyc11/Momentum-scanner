export const number = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
export const money = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(n);
export const signed = (
  n: number | null | undefined,
  kind: "money" | "percent" = "money",
) =>
  n === null || n === undefined
    ? "—"
    : `${n > 0 ? "+" : ""}${kind === "money" ? money(n) : `${number(n)}%`}`;
export const compact = (n: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
export const dateTime = (v?: string | null) =>
  v
    ? new Date(v).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not yet";
export const timeOnly = (v?: string | null) =>
  v
    ? new Date(v).toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "Not yet";
export const easternDate = (timestamp: string | number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(timestamp))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};
export const label = (s: string) =>
  s.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
export function exportCsv(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cell = (value: unknown) => {
    let s = String(value ?? "");
    if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  const text = [
    columns.map(cell).join(","),
    ...rows.map((row) => columns.map((k) => cell(row[k])).join(",")),
  ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
