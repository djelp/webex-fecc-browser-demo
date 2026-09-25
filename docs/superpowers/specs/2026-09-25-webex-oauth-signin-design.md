# Webex OAuth Sign-in — Design

**Date:** 2026-09-25
**Status:** Approved
**Builds on:** `2026-09-23-browser-calling-fecc-design.md`

## Goal

Replace the paste-a-token field on `call.html` with **Sign in with Webex** (OAuth authorization-code flow through a Webex Integration). Any Webex user can sign in (SSO works because Webex hosts the login). The caller's own token places the call. Room listing and camera commands require a signed-in session.

## Configuration (`.env`)

| Key | Meaning |
|---|---|
| `WEBEX_CLIENT_ID` | Integration client ID. OAuth is **enabled** only when this is non-empty. |
| `WEBEX_CLIENT_SECRET` | Integration client secret. Server-side only. |
| `WEBAPP_PUBLIC_URL` | Existing. Redirect URI is `${WEBAPP_PUBLIC_URL}/auth/callback`. |
| `ALLOWED_ORG_IDS` | Optional, comma-separated. Raw org UUIDs or Webex base64 org IDs. Empty = any org. |
| `ALLOWED_EMAILS` | Optional, comma-separated, case-insensitive. Empty = anyone. |

If both allow-lists are set, a user must match **either** one. Integration scopes: `spark:all spark:kms`.

## Server — new `auth.js`

`createAuth()` returns `{ router, requireSession }`; `server.js` mounts the router and guards `/api/rooms` and `/api/fecc/command` with `requireSession`. Config is read from `process.env` at request time.

- **`GET /auth/login`** — 16-byte random `state`, stored in cookie `fecc_oauth_state` (HttpOnly, Secure, SameSite=Lax, Max-Age 600). 302 to `https://webexapis.com/v1/authorize?client_id&response_type=code&redirect_uri&scope=spark:all spark:kms&state`. OAuth disabled → 503 JSON.
- **`GET /auth/callback`** — `state` query must equal the cookie, else 400. Clears the state cookie. POST `https://webexapis.com/v1/access_token` (form: `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `redirect_uri`), then `GET /v1/people/me` with the new token. Allow-list failure → 302 `/call.html?authError=not_authorized`. Webex error (`?error=` or failed exchange) → 302 `/call.html?authError=signin_failed`. Success → session, cookie `fecc_sid` (32 random bytes, HttpOnly, Secure, SameSite=Lax, Max-Age 12h), 302 `/call.html`.
- **Session store** — in-memory `Map`: `{ accessToken, refreshToken, expiresAt, createdAt, name, email }`. Absolute lifetime 12 hours. Restarting the server signs everyone out.
- **`GET /auth/session`** — no/expired session → 401. If the access token expires within 5 minutes, refresh (`grant_type=refresh_token`); refresh failure deletes the session → 401. Returns `{ name, email, accessToken }`. OAuth disabled → 503.
- **`POST /auth/logout`** — deletes the session, clears the cookie, 204.
- **`requireSession`** — when OAuth is enabled and there is no valid session → 401 `{ error: "Sign in required" }`. When OAuth is disabled it passes through (today's behaviour). Device-macro endpoints (`/startup`, `/call`, `/call-end`) are not guarded.

No new npm dependencies (`node:crypto`, hand-parsed `Cookie` header).

## Page — `call.html` / `webex-call.js`

- Token form and `localStorage` token removed. Left column shows **Sign in with Webex** (link to `/auth/login`) or "Signed in as <name>" + **Sign out**.
- On load: origin check (existing) → `GET /auth/session`. 200 → `Webex.init` with the returned token, register, then load rooms. 401 → show sign-in button, "Sign in to see rooms". 503 → "Webex sign-in is not configured on the server."
- `?authError=not_authorized` → "Your Webex account isn't allowed to use this page." `?authError=signin_failed` → "Webex sign-in failed. Try again." The query string is then removed with `history.replaceState`.
- Sign out: hang up if in a call, `meetings.unregister()`, `POST /auth/logout`, show sign-in button.

## Out of scope

Persistent session store, per-room permissions, the Webex-app tab flow (`index.html`) signing in (it will get 401 from camera commands while OAuth is on).

## Testing

`test/auth.test.js` with a faked Webex API: login redirect contents and state cookie; state mismatch → 400; full callback → session → `/auth/session` returns the token; allow-list by email and by raw org UUID (against base64 `orgId`); denied user gets no session; `/api/rooms` 401 without / 200 with session; logout; near-expiry refresh. Manual: sign in from Chrome through ngrok, call Room A, move the camera, sign out.
