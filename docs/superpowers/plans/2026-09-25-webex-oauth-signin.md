# Webex OAuth Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pasted token on `call.html` with Webex OAuth sign-in and require a session for rooms and camera commands.

**Architecture:** New `auth.js` (`createAuth()` → `{ router, requireSession }`) holds the OAuth flow and an in-memory session store; `server.js` mounts it and guards two routes. The page asks `/auth/session` for the signed-in user's token instead of reading `localStorage`.

**Tech Stack:** Express 4, `node:crypto`, `node:test`, Webex JS SDK 3.12.0.

Spec: `docs/superpowers/specs/2026-09-25-webex-oauth-signin-design.md`

## Global Constraints

- No new npm dependencies.
- OAuth enabled only when `WEBEX_CLIENT_ID` is non-empty; disabled = today's behaviour.
- Scopes: `spark:all spark:kms`. Redirect URI: `${WEBAPP_PUBLIC_URL}/auth/callback`.
- Cookies: `fecc_oauth_state` (Max-Age 600), `fecc_sid` (Max-Age 43200); both HttpOnly, Secure, SameSite=Lax, Path=/.
- Tests pin every auth-related env var before importing `server.js` (dotenv never overrides an existing key, including an empty one).

---

### Task 1: `auth.js` + server wiring

**Files:**
- Create: `auth.js`, `test/auth.test.js`
- Modify: `server.js` (import `createAuth`, mount router, guard `/api/rooms` and `/api/fecc/command`)
- Modify: `test/server.test.js` (pin `WEBEX_CLIENT_ID=""` so a configured `.env` cannot turn auth on)

**Interfaces:**
- Produces: `createAuth(): { router: express.Router, requireSession: express.RequestHandler }`; routes `GET /auth/login`, `GET /auth/callback`, `GET /auth/session` → `{ name, email, accessToken }`, `POST /auth/logout`.

- [ ] Write `test/auth.test.js` covering: login redirect + state cookie; OAuth disabled → 503; state mismatch → 400; full callback → session → `/auth/session` returns token; `ALLOWED_EMAILS` deny (no session, `authError=not_authorized`); `ALLOWED_ORG_IDS` raw UUID allows base64 `orgId`; `/api/rooms` 401 without cookie, 200 with; logout → 401 afterwards; near-expiry session triggers `grant_type=refresh_token`.
- [ ] Run `npm test` → auth tests fail (module missing).
- [ ] Implement `auth.js`; wire into `server.js`.
- [ ] Run `npm test` → all pass.
- [ ] Commit.

### Task 2: Page sign-in

**Files:**
- Modify: `public/call.html` (token form → sign-in link + signed-in row)
- Modify: `public/webex-call.js` (session fetch, authError messages, sign out; drop `localStorage` token)

- [ ] Replace markup; rewrite the sign-in section of `webex-call.js` per the spec's Page section.
- [ ] Browser check on 3100 with `WEBEX_CLIENT_ID=test` env: sign-in button shown, "Sign in to see rooms", `/auth/login` redirects to `webexapis.com/v1/authorize`; `?authError=not_authorized` shows the message; no console errors.
- [ ] Commit.

### Task 3: Hand-off

- [ ] User creates the Integration (redirect `https://<your-tunnel>.ngrok-free.app/auth/callback`, scopes `spark:all spark:kms`), adds `WEBEX_CLIENT_ID` / `WEBEX_CLIENT_SECRET` to `.env`, restarts the server, signs in from Chrome and places a call.
