import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// npm workspace commands run from apps/api; keep the documented root .env
// location stable in source and compiled builds. Render-injected values win.
dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
});

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const schema = z.object({
  NODE_ENV: z.string().default("development"),
  APP_MODE: z.enum(["demo", "paper"]).default("demo"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  SERVICE_ROLE: z.enum(["api", "worker", "combined"]).default("combined"),
  WEB_PRODUCT: z.enum(["trader", "scanner"]).default("trader"),
  DATABASE_URL: z.string().default(""),
  APCA_API_KEY_ID: z.string().default(""),
  APCA_API_SECRET_KEY: z.string().default(""),
  ALPACA_DATA_FEED: z.enum(["sip", "iex"]).default("iex"),
  PAPER_TRADING_ENABLED: bool,
  ADMIN_TOKEN: z.string().default(""),
  VIEWER_TOKEN: z.string().default(""),
  SESSION_SECRET: z.string().default(""),
  OIDC_ISSUER: z.string().default(""),
  OIDC_AUDIENCE: z.string().default(""),
  OIDC_JWKS_URL: z.string().default(""),
  PUBLIC_ORIGIN: z.string().default("http://localhost:5173"),
  DAILY_LOSS_LIMIT_PCT: z.coerce.number().min(0.1).max(3).default(3),
  RISK_PER_TRADE_PCT: z.coerce.number().min(0.01).max(0.5).default(0.25),
  MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(10).default(4),
  RESEARCH_HOUR_ET: z.coerce.number().int().min(20).max(23).default(21),
  SEED_SYMBOLS: z.string().default("SPY,AAPL,NVDA,AMD,TSLA"),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  if (c.NODE_ENV === "production") {
    if (c.APP_MODE === "paper" && !c.DATABASE_URL)
      throw new Error("Production paper mode requires DATABASE_URL");
    if (
      c.SERVICE_ROLE !== "worker" &&
      (c.ADMIN_TOKEN.length < 32 || c.SESSION_SECRET.length < 32)
    )
      throw new Error(
        "Production requires unique ADMIN_TOKEN and SESSION_SECRET (32+ characters)",
      );
    if (c.SERVICE_ROLE !== "worker" && !c.PUBLIC_ORIGIN.startsWith("https://"))
      throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
    if (c.SERVICE_ROLE === "combined" && c.APP_MODE === "paper")
      throw new Error(
        "Production paper mode requires separate api and worker roles",
      );
    if (c.VIEWER_TOKEN && c.VIEWER_TOKEN.length < 32)
      throw new Error(
        "Configured production VIEWER_TOKEN must have at least 32 characters",
      );
  }
  if (
    c.PAPER_TRADING_ENABLED &&
    (c.APP_MODE !== "paper" || !c.APCA_API_KEY_ID || !c.APCA_API_SECRET_KEY)
  )
    throw new Error(
      "Paper execution requires paper mode and broker credentials",
    );
  if (
    [c.OIDC_ISSUER, c.OIDC_JWKS_URL].some((v) => v && !v.startsWith("https://"))
  )
    throw new Error("OIDC endpoints must use HTTPS");
  if (
    [c.OIDC_ISSUER, c.OIDC_JWKS_URL, c.OIDC_AUDIENCE].some(Boolean) &&
    ![c.OIDC_ISSUER, c.OIDC_JWKS_URL, c.OIDC_AUDIENCE].every(Boolean)
  )
    throw new Error(
      "Configure OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE together",
    );
  const secrets = [c.ADMIN_TOKEN, c.VIEWER_TOKEN, c.SESSION_SECRET].filter(
    Boolean,
  );
  if (new Set(secrets).size !== secrets.length)
    throw new Error("Operator, viewer and session secrets must be different");
  return c;
}
export function safeError(e: unknown): string {
  // Never return upstream response bodies (they may contain credentials or account data).
  const msg = e instanceof Error ? e.message : "Unexpected error";
  return msg
    .replace(/(secret|token|key|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 220);
}
