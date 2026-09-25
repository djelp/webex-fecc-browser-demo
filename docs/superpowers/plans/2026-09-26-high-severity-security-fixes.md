# High-Severity Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five high-severity findings from the 2026-09-26 code review so the app can be handed to a customer to run on their own infrastructure.

**Architecture:** Four small server modules, each with one job — `config-check.js` (refuse to start misconfigured), `audit.js` (structured audit lines), `room-guard.js` (control only the room you are in a call with), `security-headers.js` (one source of truth for CSP and headers) — wired into `server.js` and `auth.js`. Inline page scripts move to files so the Content-Security-Policy needs no `'unsafe-inline'` for scripts, and the Webex SDK tag gets a Subresource Integrity hash.

**Tech Stack:** Node 22, Express 4, `node:test`, `node:crypto`. No new npm dependencies.

## Findings addressed

| # | Finding (review of 2026-09-26) | Task |
|---|---|---|
| H1 | Room and camera APIs are open when `WEBEX_CLIENT_ID` is unset (`requireSession` fails open) | 2 |
| H2 | Malformed cookie throws in `parseCookies`; Express returns a stack trace with server paths | 1 |
| H3 | Any signed-in user can control any room; no audit trail | 4, 5 |
| H5 | Legacy macro endpoints unauthenticated; DM feature defaults ON; serial sent to Webex unencoded | 3 |
| H6 | Webex SDK from CDN without integrity; no CSP; clickjacking possible | 6 |

**Out of scope (decided):** H4 — `ALLOWED_ORG_IDS` / `ALLOWED_EMAILS` stay empty by default (any Webex user may sign in). Task 5's call-bound check is what limits *control*. Medium/low findings (rate limiting, lockfile, session revocation, log PII) and the deployment kit are separate plans.

## Global Constraints

- No new npm dependencies; tests use `node:test`, `node:assert/strict`, global `fetch`.
- Must keep working on both a plain Node server (VM) and Vercel (`api/index.js` + `vercel.json`).
- Allow-lists remain empty by default; do not change `isAllowed`.
- Never send stack traces, file paths or upstream Webex error bodies to the client.
- New environment variables (exact names): `AUTH_DISABLED`, `LEGACY_MACRO_ENABLED`, `LEGACY_MACRO_KEY`, `CSP_REPORT_ONLY`.
- Webex SDK stays pinned at `webex@3.12.0`; its SRI hash is `sha384-nVUWNxB9ljc5Vl3WzDIuPVCw7BxyuNaend5go2BX6a2d3efoIyJ5tZVWXUQThKJ9` (computed 2026-09-26 from the jsDelivr file; recompute on any version change).
- `.env*` files cannot be edited by the agent; new settings are documented in the README for the user to add.

## Key design decision: call-bound control (H3)

With sign-in open to any Webex user, a static per-user room list would need an admin to maintain it. Instead, the server authorises each camera or microphone command by asking the **device** who it is in a call with:

1. At sign-in the session records the user's Webex person UUID (from `GET /v1/people/me` → `id`, base64 `ciscospark://us/PEOPLE/<uuid>`).
2. Before a command, the server reads `xStatus Call` on the target device with the bot token. The device reports the remote party as `CallbackNumber: "spark:<uuid>"` (confirmed in HWS Board 75's call history on 2026-09-25).
3. The command runs only if a call on that device has `Status: "Connected"` and its `CallbackNumber` UUID equals the session's UUID. Otherwise `403` plus an audit line.
4. A positive result is cached for 15 seconds per (user, device) so press-and-hold stays responsive; after hang-up, control lapses within that window.

Result: a signed-in stranger cannot move a camera or unmute a room they are not connected to, even with a valid session and a guessed device ID.

---

### Task 1: Safe errors (H2)

**Files:**
- Modify: `auth.js` (`parseCookies`)
- Modify: `server.js` (disable `x-powered-by`; final error handler)
- Test: `test/auth.test.js`, `test/server.test.js`

**Interfaces:** none new.

- [ ] **Step 1: Failing tests** — add to `test/auth.test.js`:

```js
test("a malformed cookie is ignored instead of crashing", async () => {
  const res = await realFetch(`${base}/api/rooms`, { headers: { Cookie: "fecc_sid=%E0%A4%A" } });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.doesNotMatch(text, /URIError|at \w+ \(|file:\/\//);
});
```

and to `test/server.test.js`:

```js
test("errors never expose stack traces or the framework", async () => {
  const res = await realFetch(`${base}/api/fecc/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid request body" });
  assert.equal(res.headers.get("x-powered-by"), null);
});
```

- [ ] **Step 2:** `npm test` → both FAIL (500 with HTML stack; `X-Powered-By: Express`).

- [ ] **Step 3: Implement.** In `auth.js` replace `parseCookies`:

```js
function parseCookies(header) {
  const out = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Malformed value: ignore this cookie rather than failing the request.
    }
  }
  return out;
}
```

In `server.js`, right after `const app = express();`:

```js
app.disable("x-powered-by");
```

and as the very last `app.use` (after `express.static(...public)`):

```js
// Last handler: log the details, send the client nothing internal.
app.use((err, req, res, next) => {
  console.error("Unhandled error", req.method, req.path, err);
  if (res.headersSent) return next(err);
  const badBody = err?.type === "entity.parse.failed";
  res.status(badBody ? 400 : 500).json({ error: badBody ? "Invalid request body" : "Internal error" });
});
```

- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `Never expose stack traces; ignore malformed cookies`.

---

### Task 2: Fail closed on missing configuration (H1)

**Files:**
- Create: `config-check.js`
- Modify: `auth.js` (`requireSession`), `server.js` (start-up check), `test/server.test.js` (use `AUTH_DISABLED`)
- Test: `test/config-check.test.js`, `test/auth.test.js`

**Interfaces — Produces:**
- `configProblems(env = process.env): string[]` — human-readable problems; empty when safe to start.
- `authDisabled(env = process.env): boolean` — true only when `AUTH_DISABLED` is exactly `true` (case-insensitive, trimmed).
- `requireSession` sets `req.webexSession` (the unsealed session object, or `null` when auth is disabled).

- [ ] **Step 1: Failing tests** — `test/config-check.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { configProblems, authDisabled } from "../config-check.js";

const full = {
  WEBEX_BOT_TOKEN: "b",
  WEBEX_CLIENT_ID: "c",
  WEBEX_CLIENT_SECRET: "s",
  WEBAPP_PUBLIC_URL: "https://app.example",
};

test("a complete configuration has no problems", () => {
  assert.deepEqual(configProblems(full), []);
});

test("missing sign-in settings are problems unless AUTH_DISABLED=true", () => {
  const env = { WEBEX_BOT_TOKEN: "b" };
  assert.equal(configProblems(env).length, 3);
  assert.deepEqual(configProblems({ ...env, AUTH_DISABLED: " TRUE " }), []);
});

test("the Vercel production URL satisfies the public URL", () => {
  const { WEBAPP_PUBLIC_URL, ...rest } = full;
  assert.deepEqual(configProblems({ ...rest, VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" }), []);
});

test("a missing bot token is always a problem", () => {
  const { WEBEX_BOT_TOKEN, ...rest } = full;
  assert.match(configProblems(rest).join(), /WEBEX_BOT_TOKEN/);
});

test("the legacy macro flow needs its key when enabled", () => {
  assert.match(configProblems({ ...full, LEGACY_MACRO_ENABLED: "true" }).join(), /LEGACY_MACRO_KEY/);
  assert.deepEqual(configProblems({ ...full, LEGACY_MACRO_ENABLED: "true", LEGACY_MACRO_KEY: "k".repeat(32) }), []);
});

test("authDisabled only accepts the exact word true", () => {
  assert.equal(authDisabled({ AUTH_DISABLED: "yes" }), false);
  assert.equal(authDisabled({}), false);
  assert.equal(authDisabled({ AUTH_DISABLED: "true" }), true);
});
```

In `test/auth.test.js`, replace the "OAuth disabled" test with:

```js
test("without sign-in configured, protected APIs fail closed", async () => {
  process.env.WEBEX_CLIENT_ID = "";
  assert.equal((await realFetch(`${base}/auth/login`, { redirect: "manual" })).status, 503);
  assert.equal((await realFetch(`${base}/api/rooms`)).status, 503);
  const cmd = await realFetch(`${base}/api/fecc/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "d", action: "rampStop" }),
  });
  assert.equal(cmd.status, 503);
  assert.equal(webexCalls.length, 0);
});
```

and add `AUTH_DISABLED: ""` to the pinned env block at the top of that file.

In `test/server.test.js`, replace `process.env.WEBEX_CLIENT_ID = "";` with:

```js
// These tests exercise the room/camera logic directly, without sign-in.
process.env.AUTH_DISABLED = "true";
```

- [ ] **Step 2:** `npm test` → config tests fail (module missing); the fail-closed test fails (`/api/rooms` returns 200/502).

- [ ] **Step 3: Implement** `config-check.js`:

```js
/**
 * Start-up configuration check. The server refuses to start when this returns problems,
 * so a missing setting can never silently turn off sign-in.
 */
export function authDisabled(env = process.env) {
  return (env.AUTH_DISABLED ?? "").trim().toLowerCase() === "true";
}

export function configProblems(env = process.env) {
  const has = (k) => (env[k] ?? "").trim().length > 0;
  const problems = [];
  if (!has("WEBEX_BOT_TOKEN")) problems.push("WEBEX_BOT_TOKEN is not set.");
  if (!authDisabled(env)) {
    if (!has("WEBEX_CLIENT_ID")) problems.push("WEBEX_CLIENT_ID is not set. Sign-in is required (AUTH_DISABLED=true is for local development only).");
    if (!has("WEBEX_CLIENT_SECRET")) problems.push("WEBEX_CLIENT_SECRET is not set.");
    if (!has("WEBAPP_PUBLIC_URL") && !has("VERCEL_PROJECT_PRODUCTION_URL")) problems.push("WEBAPP_PUBLIC_URL is not set.");
  }
  if ((env.LEGACY_MACRO_ENABLED ?? "").trim().toLowerCase() === "true" && (env.LEGACY_MACRO_KEY ?? "").trim().length < 32) {
    problems.push("LEGACY_MACRO_ENABLED=true requires LEGACY_MACRO_KEY (at least 32 characters).");
  }
  return problems;
}
```

In `auth.js`, import `authDisabled` and replace `requireSession`:

```js
  /** Guards an API route. Fails closed: no sign-in configuration means no access. */
  function requireSession(req, res, next) {
    if (authDisabled()) {
      req.webexSession = null;
      return next();
    }
    if (!oauthEnabled()) return res.status(503).json({ error: "Sign-in is not configured on the server" });
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error: "Sign in required" });
    req.webexSession = session;
    next();
  }
```

In `server.js`, import `{ configProblems, authDisabled }` and replace the `listen` block:

```js
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = configProblems();
  if (problems.length) {
    for (const p of problems) console.error("Configuration error:", p);
    process.exit(1);
  }
  if (authDisabled()) console.warn("WARNING: AUTH_DISABLED=true — anyone who can reach this server can control rooms. Never use this in production.");
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}
```

(On Vercel there is no `listen`; `requireSession` still fails closed.)

- [ ] **Step 4:** `npm test` → all pass. Also run `WEBEX_BOT_TOKEN=x WEBEX_CLIENT_ID= node server.js` → exits with code 1 and prints the WEBEX_CLIENT_ID problem.
- [ ] **Step 5:** Commit `Fail closed when sign-in is not configured`.

---

### Task 3: Lock down the legacy macro endpoints (H5)

**Files:**
- Modify: `server.js` (`dmTabEnabled`, `ensureDeviceCached`, gate `/startup`, `/call`, `/call-end`)
- Modify: `macro/integrated-fecc.js` (send the key)
- Test: `test/server.test.js`

**Interfaces — Produces:** `requireLegacyMacro(req, res, next)` Express middleware (module-private in `server.js`).

- [ ] **Step 1: Failing tests** — in `test/server.test.js` add a key constant and helper, and replace the two existing `/call` tests:

```js
const MACRO_KEY = "k".repeat(40);
function macroPost(path, body, key = MACRO_KEY) {
  return realFetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "X-Macro-Key": key } : {}) },
    body: JSON.stringify(body),
  });
}

test("legacy macro endpoints are off unless LEGACY_MACRO_ENABLED=true", async () => {
  for (const path of ["/startup", "/call", "/call-end"]) {
    assert.equal((await macroPost(path, { deviceSerial: "ABC123456" })).status, 404);
  }
  assert.equal(webexCalls.length, 0);
});

test("legacy macro endpoints need the macro key", async () => {
  process.env.LEGACY_MACRO_ENABLED = "true";
  process.env.LEGACY_MACRO_KEY = MACRO_KEY;
  assert.equal((await macroPost("/startup", { deviceSerial: "ABC123456" }, null)).status, 401);
  assert.equal((await macroPost("/startup", { deviceSerial: "ABC123456" }, "wrong")).status, 401);
  assert.equal(webexCalls.length, 0);
});

test("the DM + tab flow is off by default and invalid serials never reach Webex", async () => {
  process.env.LEGACY_MACRO_ENABLED = "true";
  process.env.LEGACY_MACRO_KEY = MACRO_KEY;
  assert.equal((await macroPost("/call", { deviceSerial: "ABC123456", callbackNumber: "spark:abc" })).status, 204);
  assert.equal((await macroPost("/startup", { deviceSerial: "x&serial=y" })).status, 400);
  assert.equal(webexCalls.length, 0);
});
```

and in `beforeEach` also `delete process.env.LEGACY_MACRO_ENABLED; delete process.env.LEGACY_MACRO_KEY;`. Remove the old "DM_TAB_ENABLED unset still performs the device lookup" test (the default is now off).

- [ ] **Step 2:** `npm test` → the three new tests fail.

- [ ] **Step 3: Implement** in `server.js`:

```js
import { createHash, timingSafeEqual } from "node:crypto";

/** `/call` sends the DM + Camera Control tab only when DM_TAB_ENABLED is exactly "true". */
function dmTabEnabled() {
  return (process.env.DM_TAB_ENABLED ?? "").trim().toLowerCase() === "true";
}

function sameSecret(a, b) {
  const h = (s) => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
}

/** Legacy RoomOS macro hooks: off unless enabled, and then only with the shared macro key. */
function requireLegacyMacro(req, res, next) {
  if ((process.env.LEGACY_MACRO_ENABLED ?? "").trim().toLowerCase() !== "true") return res.sendStatus(404);
  const expected = (process.env.LEGACY_MACRO_KEY ?? "").trim();
  if (!expected || !sameSecret(req.get("x-macro-key") ?? "", expected)) return res.sendStatus(401);
  next();
}
```

In `ensureDeviceCached`, after the type check:

```js
  if (!/^[A-Za-z0-9]{6,32}$/.test(deviceSerial)) {
    throw { statusCode: 400, message: "deviceSerial is invalid" };
  }
```

and change the lookup URL to `` `https://webexapis.com/v1/devices?serial=${encodeURIComponent(deviceSerial)}` ``.

Add `requireLegacyMacro` as the first handler on all three routes:

```js
app.post("/startup", requireLegacyMacro, handleDeviceSerialCachePost("/startup"));
app.post("/call-end", requireLegacyMacro, handleDeviceSerialCachePost("/call-end"));
app.post("/call", requireLegacyMacro, async (req, res) => {
```

In `macro/integrated-fecc.js`, under `baseUrl`:

```js
const macroKey = "PASTE_LEGACY_MACRO_KEY_HERE"; // must equal the server's LEGACY_MACRO_KEY
```

and in `httpPost` change the header list to `Header: ["Content-Type: application/json", "X-Macro-Key: " + macroKey],`.

- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `Disable legacy macro endpoints by default and require a macro key`.

---

### Task 4: Audit log and person ID in the session (H3, part 1)

**Files:**
- Create: `audit.js`
- Modify: `auth.js` (store `personUuid`; audit sign-in, denial, sign-out; drop the old `console.log` sign-in lines)
- Test: `test/audit.test.js`, `test/auth.test.js`

**Interfaces — Produces:**
- `audit(event: string, fields?: object): void` — writes one JSON line `{"type":"audit","time":ISO,"event":…,…fields}`.
- `setAuditSink(fn: (line: string) => void): void` — test hook; default sink is `console.log`.
- `idUuid(id: string): string` — exported from `auth.js`; lower-case UUID from a raw UUID or a base64 Webex ID (rename of the existing `orgUuid`).
- Session objects gain `personUuid: string`. A session without it is treated as signed out.

- [ ] **Step 1: Failing tests** — `test/audit.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, setAuditSink } from "../audit.js";

test("audit writes one JSON line with type, time and fields", () => {
  const lines = [];
  setAuditSink((l) => lines.push(l));
  audit("camera_move", { email: "a@b.c", deviceId: "d1", direction: "left" });
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.type, "audit");
  assert.equal(rec.event, "camera_move");
  assert.equal(rec.direction, "left");
  assert.ok(!Number.isNaN(Date.parse(rec.time)));
});
```

In `test/auth.test.js`: give the mocked person an id — in `beforeEach`, `meResponse = () => Response.json({ id: PERSON_ID, displayName: …, emails: …, orgId: ORG_B64 })` with

```js
const PERSON_UUID = "99999999-8888-4777-8666-555555555555";
const PERSON_ID = Buffer.from(`ciscospark://us/PEOPLE/${PERSON_UUID}`).toString("base64").replaceAll("=", "");
```

capture audit lines (`import { setAuditSink } from "../audit.js"; let auditLines = []; setAuditSink((l) => auditLines.push(JSON.parse(l)));`, reset in `beforeEach`), and add:

```js
test("sign-in, denial and sign-out are audited", async () => {
  const { sid } = await signIn();
  assert.deepEqual(auditLines.map((l) => l.event), ["signin"]);
  assert.equal(auditLines[0].personUuid, PERSON_UUID);
  await realFetch(`${base}/auth/logout`, { method: "POST", headers: { Cookie: `fecc_sid=${sid}` } });
  assert.equal(auditLines.at(-1).event, "signout");
  process.env.ALLOWED_EMAILS = "someone@else.example";
  await signIn();
  assert.equal(auditLines.at(-1).event, "signin_denied");
});
```

- [ ] **Step 2:** `npm test` → fails (module missing; no audit lines).

- [ ] **Step 3: Implement** `audit.js`:

```js
/**
 * Security audit trail: one JSON line per sign-in, denial and room-control action,
 * written to stdout for the host's log pipeline (journald, Vercel logs, SIEM).
 */
let sink = (line) => console.log(line);

export function setAuditSink(fn) {
  sink = fn;
}

export function audit(event, fields = {}) {
  sink(JSON.stringify({ type: "audit", time: new Date().toISOString(), event, ...fields }));
}
```

In `auth.js`: rename `orgUuid` → exported `idUuid` (update its two call sites); import `audit`; in the callback, after `isAllowed` fails, replace the `console.log` with `audit("signin_denied", { email: person.emails?.[0] ?? "" });`; add `personUuid: idUuid(person.id ?? "")` to the sealed session; replace `console.log("Signed in:" …)` with `audit("signin", { email: person.emails?.[0] ?? "", personUuid: idUuid(person.id ?? "") });`; in `sessionFor` return `null` when `!session.personUuid`; in `/auth/logout`:

```js
  router.post("/auth/logout", (req, res) => {
    const session = sessionFor(req);
    if (session) audit("signout", { email: session.email, personUuid: session.personUuid });
    res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
    res.sendStatus(204);
  });
```

- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `Add audit log and record the signed-in person in the session`.

---

### Task 5: Control only the room you are in a call with (H3, part 2)

**Files:**
- Create: `room-guard.js`
- Modify: `server.js` (guard + audit on `/api/fecc/command`, `GET`/`POST /api/room-mic`)
- Test: `test/room-guard.test.js`, `test/auth.test.js`

**Interfaces:**
- Consumes: `req.webexSession.personUuid` (Task 4), `audit()` (Task 4), `authDisabled()` (Task 2).
- Produces:
  - `callerUuid(value: string): string | null` — UUID from `"spark:<uuid>"`, else `null`.
  - `userInCallWithDevice({ personUuid, deviceId, headers }): Promise<boolean>` — true when the device reports a `Connected` call whose `CallbackNumber` belongs to that person; positive results cached 15 s. Throws `{ statusCode: 502, message }` when the device status cannot be read.
  - `clearRoomGuardCache(): void` — test hook.

- [ ] **Step 1: Failing tests** — `test/room-guard.test.js`:

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { callerUuid, userInCallWithDevice, clearRoomGuardCache } from "../room-guard.js";

const ME = "99999999-8888-4777-8666-555555555555";
let statusCalls = 0;
let callStatus = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).startsWith("https://webexapis.com/v1/xapi/status")) {
    statusCalls++;
    return Response.json({ result: { Call: callStatus } });
  }
  return realFetch(url);
};
beforeEach(() => {
  statusCalls = 0;
  clearRoomGuardCache();
});
const ask = () => userInCallWithDevice({ personUuid: ME, deviceId: "dev-1", headers: {} });

test("callerUuid reads spark: caller IDs only", () => {
  assert.equal(callerUuid(`spark:${ME.toUpperCase()}`), ME);
  assert.equal(callerUuid("sip:room@partner.com"), null);
  assert.equal(callerUuid(undefined), null);
});

test("allowed only when this person is in a connected call with the device", async () => {
  callStatus = [{ id: 3, Status: "Connected", CallbackNumber: `spark:${ME}` }];
  assert.equal(await ask(), true);
  clearRoomGuardCache();
  callStatus = [{ id: 3, Status: "Connected", CallbackNumber: "spark:11111111-2222-4333-8444-555555555555" }];
  assert.equal(await ask(), false);
  callStatus = [{ id: 3, Status: "Ringing", CallbackNumber: `spark:${ME}` }];
  assert.equal(await ask(), false);
  callStatus = [];
  assert.equal(await ask(), false);
});

test("a positive answer is cached briefly", async () => {
  callStatus = [{ id: 3, Status: "Connected", CallbackNumber: `spark:${ME}` }];
  await ask();
  await ask();
  assert.equal(statusCalls, 1);
});
```

In `test/auth.test.js`, extend the fetch mock so `https://webexapis.com/v1/xapi/status` returns `statusResponse(u)` (default `Response.json({ result: { Call: [] } })`) and `https://webexapis.com/v1/xapi/command/` returns `Response.json({ result: {} })`; import `clearRoomGuardCache` and call it in `beforeEach`; then add:

```js
test("camera and mic control require a live call with that room", async () => {
  const { sid } = await signIn();
  const post = (path, body) =>
    realFetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `fecc_sid=${sid}` },
      body: JSON.stringify(body),
    });
  const move = { deviceId: "dev-1", action: "rampStart", direction: "left" };

  statusResponse = () => Response.json({ result: { Call: [] } });
  assert.equal((await post("/api/fecc/command", move)).status, 403);
  assert.equal((await post("/api/room-mic", { deviceId: "dev-1", muted: false })).status, 403);
  assert.equal(auditLines.at(-1).event, "control_denied");

  statusResponse = () => Response.json({ result: { Call: [{ id: 1, Status: "Connected", CallbackNumber: `spark:${PERSON_UUID}` }] } });
  assert.equal((await post("/api/fecc/command", move)).status, 200);
  assert.equal(auditLines.at(-1).event, "camera_move");
  assert.equal((await post("/api/room-mic", { deviceId: "dev-1", muted: false })).status, 200);
  assert.deepEqual([auditLines.at(-1).event, auditLines.at(-1).muted], ["room_mic", false]);
});
```

- [ ] **Step 2:** `npm test` → fails (module missing; commands return 200 without a call).

- [ ] **Step 3: Implement** `room-guard.js`:

```js
/**
 * Call-bound authorisation: a user may control a room only while that room reports a
 * connected call from them. Uses the device's own call status (xStatus Call) via the bot.
 */
const CACHE_MS = 15 * 1000;
const cache = new Map(); // "<personUuid>|<deviceId>" -> expiry time (ms)

export function clearRoomGuardCache() {
  cache.clear();
}

export function callerUuid(value) {
  const m = /^spark:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(String(value ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

export async function userInCallWithDevice({ personUuid, deviceId, headers }) {
  const key = `${personUuid}|${deviceId}`;
  if ((cache.get(key) ?? 0) > Date.now()) return true;
  const res = await fetch(
    `https://webexapis.com/v1/xapi/status?deviceId=${encodeURIComponent(deviceId)}&name=Call.*`,
    { headers }
  );
  if (!res.ok) {
    console.error("Room guard: call status error", res.status, await res.text());
    throw { statusCode: 502, message: "Could not check the room's call" };
  }
  const data = await res.json();
  const raw = data?.result?.Call ?? [];
  const calls = Array.isArray(raw) ? raw : [raw];
  const inCall = calls.some((c) => c?.Status === "Connected" && callerUuid(c.CallbackNumber) === personUuid);
  if (inCall) cache.set(key, Date.now() + CACHE_MS);
  return inCall;
}
```

In `server.js`, import `userInCallWithDevice` and `audit`, and add:

```js
/** Allows the request only if the signed-in user is in a connected call with the target device. */
function requireCallWith(getDeviceId) {
  return async (req, res, next) => {
    if (authDisabled()) return next();
    const raw = getDeviceId(req);
    const deviceId = typeof raw === "string" ? stripIdPadding(raw.trim()) : "";
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
    const who = req.webexSession;
    try {
      if (await userInCallWithDevice({ personUuid: who.personUuid, deviceId, headers })) return next();
    } catch (err) {
      return sendHttpError(res, err);
    }
    audit("control_denied", { email: who.email, personUuid: who.personUuid, deviceId, path: req.path });
    res.status(403).json({ error: "You can only control a room you are in a call with." });
  };
}

function auditControl(req, event, fields) {
  const who = req.webexSession;
  if (who) audit(event, { email: who.email, personUuid: who.personUuid, ...fields });
}
```

Wire it (keep existing handler bodies):

```js
app.post("/api/fecc/command", requireSession, requireCallWith((req) => req.body?.deviceId), async (req, res) => {
```
```js
app.get("/api/room-mic", requireSession, requireCallWith((req) => req.query.deviceId), async (req, res) => {
```
```js
app.post("/api/room-mic", requireSession, requireCallWith((req) => req.body?.deviceId), async (req, res) => {
```

and record successful actions: in `/api/fecc/command` after a successful `rampStart`, `auditControl(req, "camera_move", { deviceId: stripIdPadding(deviceId.trim()), direction });` (not on `rampStop`, to keep the log readable); in `POST /api/room-mic` after success, `auditControl(req, "room_mic", { deviceId: stripIdPadding(deviceId.trim()), muted });`.

- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5: Live check (required — the status shape is from call history, not yet from a live `xStatus Call` read).** Deploy to a preview or run locally behind a tunnel, sign in, dial HWS Board 75, and confirm: arrows and **Mute room** work; the server log shows `camera_move` / `room_mic` audit lines. Then, in a second browser signed in as a different Webex user and **not** in the call, call `POST /api/fecc/command` for that device from the console → `403` and a `control_denied` line. If the device returns `Call` in another shape (e.g. `CallbackNumber` absent while connected), adjust `userInCallWithDevice` and its test to match the observed payload before continuing.
- [ ] **Step 6:** Commit `Allow camera and mic control only during a call with that room`.

---

### Task 6: Security headers, CSP and SDK integrity (H6)

**Files:**
- Create: `security-headers.js`, `public/login.js`, `public/legacy-tab.js`
- Modify: `server.js` (header middleware), `vercel.json` (same headers for CDN-served files), `public/call.html` (SRI), `public/login.html`, `public/index.html` (inline scripts → files)
- Test: `test/security-headers.test.js`

**Interfaces — Produces:** `CSP: string`, `BASE_HEADERS: Record<string,string>`, `securityHeaders(env = process.env): Record<string,string>` — `BASE_HEADERS` plus `Content-Security-Policy` (or `Content-Security-Policy-Report-Only` when `CSP_REPORT_ONLY=true`).

- [ ] **Step 1: Failing tests** — `test/security-headers.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { CSP, BASE_HEADERS, securityHeaders } from "../security-headers.js";

test("CSP blocks framing, plugins and inline scripts", () => {
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /object-src 'none'/);
  const scriptSrc = CSP.split(";").find((d) => d.trim().startsWith("script-src"));
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
});

test("report-only mode switches the header name", () => {
  assert.ok(securityHeaders({})["Content-Security-Policy"]);
  assert.ok(securityHeaders({ CSP_REPORT_ONLY: "true" })["Content-Security-Policy-Report-Only"]);
});

test("vercel.json sends the same headers as the Node server", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url)));
  const sent = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
  for (const [k, v] of Object.entries(BASE_HEADERS)) assert.equal(sent[k], v, k);
  assert.equal(sent["Content-Security-Policy"] ?? sent["Content-Security-Policy-Report-Only"], CSP);
});

test("pages have no inline scripts and the SDK tag carries its integrity hash", () => {
  const dir = new URL("../public/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
    const html = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f} has an inline <script>`);
  }
  const call = readFileSync(new URL("call.html", dir), "utf8");
  assert.match(call, /webex@3\.12\.0\/umd\/webex\.min\.js" integrity="sha384-nVUWNxB9ljc5Vl3WzDIuPVCw7BxyuNaend5go2BX6a2d3efoIyJ5tZVWXUQThKJ9" crossorigin="anonymous"/);
});
```

and in `test/server.test.js`:

```js
test("every response carries the security headers", async () => {
  const res = await realFetch(`${base}/call.html`);
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});
```

- [ ] **Step 2:** `npm test` → fails.

- [ ] **Step 3: Implement** `security-headers.js` (hosts from the Web SDK bundle's own endpoint list, 2026-09-26):

```js
/** One source of truth for security headers; server.js sends them, vercel.json mirrors them. */
const WEBEX_HTTPS = "https://webexapis.com https://*.webexapis.com https://*.webex.com https://*.wbx2.com https://*.ciscospark.com";
const WEBEX_WSS = "wss://*.webex.com wss://*.wbx2.com wss://*.ciscospark.com";

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  `connect-src 'self' ${WEBEX_HTTPS} ${WEBEX_WSS}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export const BASE_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function securityHeaders(env = process.env) {
  const reportOnly = (env.CSP_REPORT_ONLY ?? "").trim().toLowerCase() === "true";
  return { ...BASE_HEADERS, [reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy"]: CSP };
}
```

In `server.js`, directly after `app.disable("x-powered-by");`:

```js
app.use((req, res, next) => {
  for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
  next();
});
```

`vercel.json` (start in report-only; Step 5 switches to enforcing):

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "no-referrer" },
        { "key": "Permissions-Policy", "value": "camera=(self), microphone=(self), geolocation=(), payment=()" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Content-Security-Policy-Report-Only", "value": "<paste CSP exactly as exported by security-headers.js>" }
      ]
    }
  ]
}
```

Generate the CSP value with `node -e 'import("./security-headers.js").then(m=>console.log(m.CSP))'` and paste it; the test keeps the two in step.

`public/call.html` — the SDK tag becomes:

```html
<script src="https://cdn.jsdelivr.net/npm/webex@3.12.0/umd/webex.min.js" integrity="sha384-nVUWNxB9ljc5Vl3WzDIuPVCw7BxyuNaend5go2BX6a2d3efoIyJ5tZVWXUQThKJ9" crossorigin="anonymous"></script>
```

`public/login.html` — move the inline `<script>` body verbatim into `public/login.js` and replace the tag with `<script src="/login.js"></script>`. `public/index.html` — move both inline scripts, in order, into `public/legacy-tab.js` and replace them with `<script src="/legacy-tab.js"></script>` placed after `/fecc-controls.js`. (Wrap the redirect line as the first statement of the new file.)

- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5: Live CSP rollout.** With `CSP_REPORT_ONLY=true` locally (and the report-only `vercel.json`), sign in, place a call, move the camera and toggle the room mic with the browser console open. Add any host reported as a violation to `WEBEX_HTTPS`/`WEBEX_WSS` (re-paste into `vercel.json`). When a full call produces no violations, switch `vercel.json` to `Content-Security-Policy`, unset `CSP_REPORT_ONLY`, repeat the call once, and confirm the SDK still registers and media flows.
- [ ] **Step 6:** Commit `Add CSP, security headers and SDK integrity; move inline scripts to files`.

---

### Task 7: Documentation and hand-off

**Files:**
- Modify: `README.md` (Configuration table, Security model → "What the demo implements", Troubleshooting, legacy flow)

- [ ] **Step 1:** Configuration table gains:

| Variable | Required | Purpose |
|---|---|---|
| `AUTH_DISABLED` | No | `true` runs without sign-in **for local development only**; the server warns loudly. |
| `LEGACY_MACRO_ENABLED` | No | `true` turns on `/startup`, `/call`, `/call-end` for the old Webex App tab macro. Off by default. |
| `LEGACY_MACRO_KEY` | With the above | Shared secret (≥ 32 chars) the macro sends as `X-Macro-Key`. |
| `CSP_REPORT_ONLY` | No | `true` sends the CSP as report-only while you verify a new deployment. |

and `DM_TAB_ENABLED` now reads "`true` enables the legacy bot DM + room tab (off by default)". Add `NODE_ENV=production` to the deployment notes.

- [ ] **Step 2:** Security model: move H1, H2, H5, H6 and the call-bound control + audit log from "Before a clinical pilot" into "What the demo implements"; note that audit lines are JSON with `"type":"audit"` on stdout. Troubleshooting: "The camera doesn't move and the status says *You can only control a room you are in a call with*" → the call dropped or you are signed in as a different Webex user than the one in the call.
- [ ] **Step 3:** Legacy flow section: set `LEGACY_MACRO_ENABLED=true`, a `LEGACY_MACRO_KEY`, and paste the key into `macroKey` in the macro.
- [ ] **Step 4:** Tell the user which settings to add to `.env` and Vercel (none are required for the current Vercel deployment; `WEBEX_CLIENT_ID`/`SECRET` are already set). Commit `Document security settings`, push, and confirm the Vercel deployment serves the new headers (`curl -sI https://<project>.vercel.app/call.html`).

---

## Verification checklist (after all tasks)

- `npm test` passes.
- `WEBEX_BOT_TOKEN=x node server.js` (no client ID) exits with a configuration error.
- `curl -H 'Cookie: fecc_sid=%E0' …/api/rooms` → `401` JSON, no stack trace.
- `curl -sI …/call.html` shows CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, no `X-Powered-By`.
- `POST /startup` → `404` unless `LEGACY_MACRO_ENABLED=true`.
- Live call: controls work in your own call; a different signed-in user gets `403`; audit lines appear for sign-in, camera moves, mic changes and denials.
