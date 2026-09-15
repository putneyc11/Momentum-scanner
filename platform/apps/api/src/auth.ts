import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

export type Identity = {
  role: "admin" | "viewer";
  sub: string;
  expiresAt?: number;
};
export type AuthedRequest = Request & { identity?: Identity };
export function streamLifetime(identity: Identity, now = Date.now()) {
  return Math.max(
    0,
    Math.min(30 * 60000, (identity.expiresAt ?? now + 30 * 60000) - now),
  );
}
function equal(a: string, b: string) {
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return !!a && !!b && crypto.timingSafeEqual(ah, bh);
}
export function auth(c: Config) {
  const secret = c.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
  const jwks = c.OIDC_JWKS_URL
    ? createRemoteJWKSet(new URL(c.OIDC_JWKS_URL))
    : null;
  function sign(identity: Identity) {
    const value = Buffer.from(
      JSON.stringify({ ...identity, exp: Date.now() + 8 * 3600000 }),
    ).toString("base64url");
    return `${value}.${crypto.createHmac("sha256", secret).update(value).digest("base64url")}`;
  }
  function decode(value: string): Identity | null {
    try {
      const [body, sig] = value.split(".");
      if (
        !equal(
          sig,
          crypto.createHmac("sha256", secret).update(body).digest("base64url"),
        )
      )
        return null;
      const j = JSON.parse(Buffer.from(body, "base64url").toString());
      return j.exp > Date.now() && ["admin", "viewer"].includes(j.role)
        ? { role: j.role, sub: j.sub, expiresAt: j.exp }
        : null;
    } catch {
      return null;
    }
  }
  async function identity(req: Request): Promise<Identity | null> {
    if (c.APP_MODE === "demo" && c.NODE_ENV !== "production")
      return { role: "admin", sub: "local-demo" };
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    if (equal(bearer, c.ADMIN_TOKEN)) return { role: "admin", sub: "operator" };
    if (equal(bearer, c.VIEWER_TOKEN))
      return { role: "viewer", sub: "private-preview" };
    if (bearer && jwks && c.OIDC_ISSUER && c.OIDC_AUDIENCE) {
      try {
        const { payload } = await jwtVerify(bearer, jwks, {
          issuer: c.OIDC_ISSUER,
          audience: c.OIDC_AUDIENCE,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["exp", "iat", "sub"],
        });
        if (!payload.sub || payload.momentum_scanner !== true) return null;
        return {
          role: "viewer",
          sub: payload.sub,
          expiresAt: payload.exp! * 1000,
        };
      } catch {
        return null;
      }
    }
    // An invalid Authorization header cannot borrow an otherwise valid browser cookie.
    if (req.headers.authorization) return null;
    return req.cookies?.momentum_session
      ? decode(req.cookies.momentum_session)
      : null;
  }
  const requireAuth = async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const id = await identity(req);
    if (!id) {
      res
        .status(401)
        .json({ error: "Sign in to continue", code: "AUTH_REQUIRED" });
      return;
    }
    req.identity = id;
    next();
  };
  const requireAdmin = (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (req.identity?.role !== "admin") {
      res.status(403).json({ error: "Operator access required" });
      return;
    }
    next();
  };
  const csrf = (req: Request, res: Response, next: NextFunction) => {
    if (
      ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
      req.headers.authorization
    ) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (!origin || origin !== c.PUBLIC_ORIGIN) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).json({ error: "JSON required" });
      return;
    }
    next();
  };
  const login = (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const role = equal(token, c.ADMIN_TOKEN)
      ? "admin"
      : equal(token, c.VIEWER_TOKEN)
        ? "viewer"
        : null;
    if (!role) {
      res.status(401).json({ error: "Invalid access token" });
      return;
    }
    res.cookie(
      "momentum_session",
      sign({ role, sub: role === "admin" ? "operator" : "private-preview" }),
      {
        httpOnly: true,
        secure: c.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 8 * 3600000,
        path: "/",
      },
    );
    res.json({ authenticated: true, role, mode: c.APP_MODE });
  };
  return { identity, requireAuth, requireAdmin, csrf, login };
}
