import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Pin every auth-related variable so a developer's .env cannot leak in (dotenv never overrides existing keys).
Object.assign(process.env, {
  WEBEX_BOT_TOKEN: "test-bot-token",
  WEBEX_CLIENT_ID: "client-123",
  WEBEX_CLIENT_SECRET: "secret-456",
  WEBAPP_PUBLIC_URL: "https://fecc.example.com",
  ALLOWED_ORG_IDS: "",
  ALLOWED_EMAILS: "",
});

const ORG_UUID = "11111111-2222-4333-8444-555555555555";
const ORG_B64 = Buffer.from(`ciscospark://us/ORGANIZATION/${ORG_UUID}`).toString("base64").replaceAll("=", "");

const realFetch = globalThis.fetch;
/** @type {{ url: string, init?: RequestInit }[]} */
let webexCalls = [];
let tokenResponse;
let meResponse;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://webexapis.com/")) return realFetch(url, init);
  webexCalls.push({ url: u, init });
  if (u === "https://webexapis.com/v1/access_token") return tokenResponse(init);
  if (u === "https://webexapis.com/v1/people/me") return meResponse(init);
  if (u.startsWith("https://webexapis.com/v1/devices")) return Response.json({ items: [] });
  return new Response("unexpected", { status: 500 });
};

const { app } = await import("../server.js");

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  webexCalls = [];
  process.env.WEBEX_CLIENT_ID = "client-123";
  process.env.ALLOWED_ORG_IDS = "";
  process.env.ALLOWED_EMAILS = "";
  tokenResponse = () =>
    Response.json({ access_token: "user-access", expires_in: 1209599, refresh_token: "user-refresh", refresh_token_expires_in: 7776000 });
  meResponse = () => Response.json({ displayName: "Dr Test", emails: ["Dr.Test@Clinic.example"], orgId: ORG_B64 });
});

/** Parses Set-Cookie headers into { name: value }. */
function cookiesFrom(res) {
  const out = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

async function login() {
  const res = await realFetch(`${base}/auth/login`, { redirect: "manual" });
  const state = new URL(res.headers.get("location")).searchParams.get("state");
  return { res, state, stateCookie: cookiesFrom(res).fecc_oauth_state };
}

/** Runs the full login + callback and returns the session cookie value (or undefined). */
async function signIn() {
  const { state, stateCookie } = await login();
  const res = await realFetch(`${base}/auth/callback?code=the-code&state=${state}`, {
    redirect: "manual",
    headers: { Cookie: `fecc_oauth_state=${stateCookie}` },
  });
  return { res, sid: cookiesFrom(res).fecc_sid || undefined };
}

test("GET /auth/login redirects to Webex authorize with state cookie", async () => {
  const { res, state, stateCookie } = await login();
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, "https://webexapis.com/v1/authorize");
  assert.equal(loc.searchParams.get("client_id"), "client-123");
  assert.equal(loc.searchParams.get("response_type"), "code");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://fecc.example.com/auth/callback");
  assert.equal(loc.searchParams.get("scope"), "spark:all spark:kms");
  assert.ok(state && state.length >= 16);
  assert.equal(stateCookie, state);
  const raw = res.headers.getSetCookie().join("\n");
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
});

test("OAuth disabled: /auth/login and /auth/session return 503 and APIs stay open", async () => {
  process.env.WEBEX_CLIENT_ID = "";
  assert.equal((await realFetch(`${base}/auth/login`, { redirect: "manual" })).status, 503);
  assert.equal((await realFetch(`${base}/auth/session`)).status, 503);
  assert.equal((await realFetch(`${base}/api/rooms`)).status, 200);
});

test("callback rejects a state that does not match the cookie", async () => {
  const { stateCookie } = await login();
  const res = await realFetch(`${base}/auth/callback?code=x&state=forged`, {
    redirect: "manual",
    headers: { Cookie: `fecc_oauth_state=${stateCookie}` },
  });
  assert.equal(res.status, 400);
  assert.equal(webexCalls.length, 0);
});

test("full sign-in creates a session that returns the user's token", async () => {
  const { res, sid } = await signIn();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/call.html");
  assert.ok(sid);

  const exchange = webexCalls.find((c) => c.url.endsWith("/v1/access_token"));
  const form = new URLSearchParams(exchange.init.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "the-code");
  assert.equal(form.get("client_secret"), "secret-456");
  assert.equal(form.get("redirect_uri"), "https://fecc.example.com/auth/callback");

  const session = await realFetch(`${base}/auth/session`, { headers: { Cookie: `fecc_sid=${sid}` } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { name: "Dr Test", email: "Dr.Test@Clinic.example", accessToken: "user-access" });
});

test("ALLOWED_EMAILS denies other users and creates no session", async () => {
  process.env.ALLOWED_EMAILS = "someone@else.example";
  const { res, sid } = await signIn();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login.html?authError=not_authorized");
  assert.equal(sid, undefined);
});

test("ALLOWED_EMAILS matches case-insensitively", async () => {
  process.env.ALLOWED_EMAILS = " other@x.example , dr.test@clinic.example ";
  const { sid } = await signIn();
  assert.ok(sid);
});

test("ALLOWED_ORG_IDS accepts a raw org UUID against the base64 orgId", async () => {
  process.env.ALLOWED_ORG_IDS = ORG_UUID;
  const { sid } = await signIn();
  assert.ok(sid);
});

test("failed code exchange redirects with signin_failed", async () => {
  tokenResponse = () => new Response("bad", { status: 400 });
  const { res, sid } = await signIn();
  assert.equal(res.headers.get("location"), "/login.html?authError=signin_failed");
  assert.equal(sid, undefined);
});

test("guarded APIs need a session when OAuth is enabled", async () => {
  assert.equal((await realFetch(`${base}/api/rooms`)).status, 401);
  const cmd = await realFetch(`${base}/api/fecc/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "d", action: "rampStop" }),
  });
  assert.equal(cmd.status, 401);
  assert.equal((await realFetch(`${base}/api/room-mic?deviceId=d`)).status, 401);
  const mic = await realFetch(`${base}/api/room-mic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "d", muted: false }),
  });
  assert.equal(mic.status, 401);
  const { sid } = await signIn();
  assert.equal((await realFetch(`${base}/api/rooms`, { headers: { Cookie: `fecc_sid=${sid}` } })).status, 200);
});

test("logout clears the session cookie", async () => {
  const { sid } = await signIn();
  const out = await realFetch(`${base}/auth/logout`, { method: "POST", headers: { Cookie: `fecc_sid=${sid}` } });
  assert.equal(out.status, 204);
  assert.match(out.headers.getSetCookie().join("\n"), /fecc_sid=;.*Max-Age=0/);
});

test("a tampered session cookie is rejected", async () => {
  const { sid } = await signIn();
  const flipped = sid.slice(0, -2) + (sid.endsWith("AA") ? "BB" : "AA");
  const res = await realFetch(`${base}/auth/session`, { headers: { Cookie: `fecc_sid=${flipped}` } });
  assert.equal(res.status, 401);
  assert.equal((await realFetch(`${base}/api/rooms`, { headers: { Cookie: `fecc_sid=${flipped}` } })).status, 401);
});

test("the session cookie does not contain the token in readable form", async () => {
  const { sid } = await signIn();
  assert.ok(!decodeURIComponent(sid).includes("user-access"));
  assert.ok(!Buffer.from(decodeURIComponent(sid), "base64url").toString("latin1").includes("user-access"));
});

test("redirect URI falls back to the Vercel production URL", async () => {
  const saved = process.env.WEBAPP_PUBLIC_URL;
  process.env.WEBAPP_PUBLIC_URL = "";
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "fecc-demo.vercel.app";
  try {
    const { res } = await login();
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.searchParams.get("redirect_uri"), "https://fecc-demo.vercel.app/auth/callback");
  } finally {
    process.env.WEBAPP_PUBLIC_URL = saved;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  }
});

test("session near expiry refreshes the access token", async () => {
  tokenResponse = (init) => {
    const form = new URLSearchParams(init.body);
    return form.get("grant_type") === "refresh_token"
      ? Response.json({ access_token: "refreshed-access", expires_in: 1209599, refresh_token: "user-refresh-2" })
      : Response.json({ access_token: "short-access", expires_in: 60, refresh_token: "user-refresh" });
  };
  const { sid } = await signIn();
  const session = await realFetch(`${base}/auth/session`, { headers: { Cookie: `fecc_sid=${sid}` } });
  assert.equal((await session.json()).accessToken, "refreshed-access");
  const refresh = webexCalls.filter((c) => c.url.endsWith("/v1/access_token")).at(-1);
  const form = new URLSearchParams(refresh.init.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "user-refresh");

  // The refreshed tokens come back in a new cookie; using it needs no further refresh.
  const newSid = cookiesFrom(session).fecc_sid;
  assert.ok(newSid && newSid !== sid);
  const callsBefore = webexCalls.length;
  const again = await realFetch(`${base}/auth/session`, { headers: { Cookie: `fecc_sid=${newSid}` } });
  assert.equal((await again.json()).accessToken, "refreshed-access");
  assert.equal(webexCalls.length, callsBefore);
});
