import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import express from "express";

const AUTHORIZE_URL = "https://webexapis.com/v1/authorize";
const TOKEN_URL = "https://webexapis.com/v1/access_token";
const ME_URL = "https://webexapis.com/v1/people/me";
const SCOPES = "spark:all spark:kms";

const STATE_COOKIE = "fecc_oauth_state";
const SESSION_COOKIE = "fecc_sid";
const STATE_MAX_AGE_S = 600;
const SESSION_MAX_AGE_S = 12 * 60 * 60;
/** Refresh the access token when it has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Config is read per request so .env changes and tests take effect without re-importing. */
function config() {
  const list = (v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    clientId: (process.env.WEBEX_CLIENT_ID ?? "").trim(),
    clientSecret: (process.env.WEBEX_CLIENT_SECRET ?? "").trim(),
    redirectUri: `${publicBaseUrl()}/auth/callback`,
    allowedOrgIds: list(process.env.ALLOWED_ORG_IDS).map(orgUuid),
    allowedEmails: list(process.env.ALLOWED_EMAILS).map((e) => e.toLowerCase()),
  };
}

/** WEBAPP_PUBLIC_URL, else the Vercel production domain, with no trailing slash. */
function publicBaseUrl() {
  const explicit = (process.env.WEBAPP_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  return vercel ? `https://${vercel}` : "";
}

// ---- Encrypted cookie sessions ---------------------------------------------------
// Sessions live in the browser as an AES-256-GCM sealed cookie, so any server instance
// (including serverless ones) can read them. The key derives from SESSION_SECRET, or
// from the integration's client secret when that is not set.

function sessionKey() {
  const secret = (process.env.SESSION_SECRET ?? "").trim() || (process.env.WEBEX_CLIENT_SECRET ?? "").trim();
  if (!secret) return null;
  return Buffer.from(hkdfSync("sha256", secret, "fecc-session", "fecc-session-v1", 32));
}

function seal(data) {
  const key = sessionKey();
  if (!key) throw new Error("No session key: set WEBEX_CLIENT_SECRET or SESSION_SECRET");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Returns the session object, or null if the cookie is missing, tampered with or sealed with another key. */
function unseal(value) {
  const key = sessionKey();
  if (!key || !value) return null;
  try {
    const buf = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function oauthEnabled() {
  return config().clientId.length > 0;
}

/** Webex org IDs arrive base64-encoded (`ciscospark://us/ORGANIZATION/<uuid>`); compare on the UUID. */
function orgUuid(id) {
  if (/^[0-9a-f-]{36}$/i.test(id)) return id.toLowerCase();
  try {
    const decoded = Buffer.from(id, "base64").toString("utf8");
    return (decoded.split("/").pop() || id).toLowerCase();
  } catch {
    return id.toLowerCase();
  }
}

function isAllowed(person, cfg) {
  if (cfg.allowedOrgIds.length === 0 && cfg.allowedEmails.length === 0) return true;
  const orgOk = cfg.allowedOrgIds.includes(orgUuid(person.orgId ?? ""));
  const emails = (person.emails ?? []).map((e) => String(e).toLowerCase());
  const emailOk = emails.some((e) => cfg.allowedEmails.includes(e));
  return orgOk || emailOk;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeS) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

/** POSTs to the Webex token endpoint; returns the parsed body or throws. */
async function requestTokens(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(`Webex token endpoint ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Webex OAuth (authorization code) sign-in with encrypted cookie sessions.
 * @returns {{ router: import("express").Router, requireSession: import("express").RequestHandler }}
 */
export function createAuth() {
  /** @returns {{ accessToken: string, refreshToken: string, expiresAt: number, createdAt: number, name: string, email: string } | null} */
  function sessionFor(req) {
    const session = unseal(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!session || Date.now() - session.createdAt > SESSION_MAX_AGE_S * 1000) return null;
    return session;
  }

  /** Cookie Max-Age for a session so it never outlives its 12-hour absolute lifetime. */
  function remainingAgeS(session) {
    return Math.max(0, Math.floor(SESSION_MAX_AGE_S - (Date.now() - session.createdAt) / 1000));
  }

  const router = express.Router();

  router.get("/auth/login", (req, res) => {
    const cfg = config();
    if (!cfg.clientId) return res.status(503).json({ error: "Webex sign-in is not configured" });
    const state = randomBytes(16).toString("hex");
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: "code",
      redirect_uri: cfg.redirectUri,
      scope: SCOPES,
      state,
    })
      .toString()
      .replaceAll("+", "%20"); // Webex's own authorize links encode the scope separator as %20
    res.setHeader("Set-Cookie", cookie(STATE_COOKIE, state, STATE_MAX_AGE_S));
    res.redirect(302, url.toString());
  });

  router.get("/auth/callback", async (req, res) => {
    const cfg = config();
    if (!cfg.clientId) return res.status(503).json({ error: "Webex sign-in is not configured" });
    const expectedState = parseCookies(req.headers.cookie)[STATE_COOKIE];
    const { code, state, error } = req.query;
    if (!expectedState || typeof state !== "string" || state !== expectedState) {
      return res.status(400).send("Sign-in expired or was tampered with. Go back and sign in again.");
    }
    const clearState = cookie(STATE_COOKIE, "", 0);
    if (error || typeof code !== "string" || !code) {
      console.error("OAuth callback error from Webex:", error);
      res.setHeader("Set-Cookie", clearState);
      return res.redirect(302, "/login.html?authError=signin_failed");
    }
    try {
      const tokens = await requestTokens({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: cfg.redirectUri,
      });
      const meRes = await fetch(ME_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (!meRes.ok) throw new Error(`people/me ${meRes.status}`);
      const person = await meRes.json();
      if (!isAllowed(person, cfg)) {
        console.log("Sign-in denied by allow-list:", person.emails?.[0]);
        res.setHeader("Set-Cookie", clearState);
        return res.redirect(302, "/login.html?authError=not_authorized");
      }
      const now = Date.now();
      const sealed = seal({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: now + Number(tokens.expires_in) * 1000,
        createdAt: now,
        name: person.displayName || person.emails?.[0] || "Webex user",
        email: person.emails?.[0] ?? "",
      });
      console.log("Signed in:", person.emails?.[0]);
      res.setHeader("Set-Cookie", [clearState, cookie(SESSION_COOKIE, sealed, SESSION_MAX_AGE_S)]);
      res.redirect(302, "/call.html");
    } catch (err) {
      console.error("OAuth sign-in failed:", err.message);
      res.setHeader("Set-Cookie", clearState);
      res.redirect(302, "/login.html?authError=signin_failed");
    }
  });

  router.get("/auth/session", async (req, res) => {
    const cfg = config();
    if (!cfg.clientId) return res.status(503).json({ error: "Webex sign-in is not configured" });
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error: "Not signed in" });
    if (session.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      try {
        const tokens = await requestTokens({
          grant_type: "refresh_token",
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: session.refreshToken,
        });
        session.accessToken = tokens.access_token;
        session.refreshToken = tokens.refresh_token || session.refreshToken;
        session.expiresAt = Date.now() + Number(tokens.expires_in) * 1000;
        res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, seal(session), remainingAgeS(session)));
      } catch (err) {
        console.error("Token refresh failed:", err.message);
        res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
        return res.status(401).json({ error: "Session expired" });
      }
    }
    res.json({ name: session.name, email: session.email, accessToken: session.accessToken });
  });

  router.post("/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
    res.sendStatus(204);
  });

  /** Guards an API route: requires a session when OAuth is configured, otherwise passes through. */
  function requireSession(req, res, next) {
    if (!oauthEnabled() || sessionFor(req)) return next();
    res.status(401).json({ error: "Sign in required" });
  }

  return { router, requireSession };
}
