import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.WEBEX_BOT_TOKEN = "test-bot-token";
// Keep OAuth off here even if .env configures it (dotenv never overrides an existing key).
process.env.WEBEX_CLIENT_ID = "";

const realFetch = globalThis.fetch;
/** @type {{ url: string, init?: RequestInit }[]} */
let webexCalls = [];
/** @type {(url: string, init?: RequestInit) => Response} */
let webexResponder = () => new Response("{}", { status: 500 });

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://webexapis.com/")) {
    webexCalls.push({ url: u, init });
    return webexResponder(u, init);
  }
  return realFetch(url, init);
};

const { app, roomsFromDevices } = await import("../server.js");

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
  delete process.env.DM_TAB_ENABLED;
});

const devices = [
  { id: "ZGV2LWI=", displayName: "Room B", primarySipUrl: "b@x.rooms.webex.com", product: "Cisco Room Bar", connectionStatus: "connected_with_issues" },
  { id: "ZGV2LWE", displayName: "Room A", primarySipUrl: "a@x.rooms.webex.com", product: "Cisco Desk Pro", connectionStatus: "disconnected" },
  { id: "bmF2", displayName: "Room A", primarySipUrl: "a@x.rooms.webex.com", product: "Cisco Room Navigator", connectionStatus: "connected" },
  { id: "bm9zaXA", displayName: "No SIP", product: "Cisco Desk" },
  {
    id: Buffer.from("ciscospark://urn:TEAM:us-west-2_r/PERIPHERAL/mic-1").toString("base64"),
    displayName: "Room B",
    primarySipUrl: "b@x.rooms.webex.com",
    product: "Cisco Ceiling Microphone Pro",
    connectionStatus: "connected",
  },
];

test("roomsFromDevices maps, filters, strips padding and sorts", () => {
  assert.deepEqual(roomsFromDevices(devices), [
    { name: "Room A", sipUri: "a@x.rooms.webex.com", deviceId: "ZGV2LWE", online: false },
    { name: "Room B", sipUri: "b@x.rooms.webex.com", deviceId: "ZGV2LWI", online: true },
  ]);
  assert.deepEqual(roomsFromDevices(undefined), []);
});

test("GET /api/rooms returns rooms using the bot token", async () => {
  webexResponder = () => Response.json({ items: devices });
  const res = await realFetch(`${base}/api/rooms`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.length, 2);
  assert.equal(webexCalls.length, 1);
  assert.match(webexCalls[0].url, /^https:\/\/webexapis\.com\/v1\/devices/);
  assert.equal(webexCalls[0].init.headers.Authorization, "Bearer test-bot-token");
});

test("GET /api/rooms returns 502 when Webex fails", async () => {
  webexResponder = () => new Response("nope", { status: 500 });
  const res = await realFetch(`${base}/api/rooms`);
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error);
});

test("POST /call with DM_TAB_ENABLED=false returns 204 and calls no Webex APIs", async () => {
  process.env.DM_TAB_ENABLED = " False ";
  const res = await realFetch(`${base}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceSerial: "SERIAL1", callbackNumber: "spark:abc" }),
  });
  assert.equal(res.status, 204);
  assert.equal(webexCalls.length, 0);
});

test("POST /call with DM_TAB_ENABLED unset still performs the device lookup", async () => {
  webexResponder = () => new Response("nope", { status: 500 });
  const res = await realFetch(`${base}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceSerial: "SERIAL2", callbackNumber: "spark:abc" }),
  });
  assert.equal(res.status, 502);
  assert.equal(webexCalls.length, 1);
});

test("GET /api/room-mic reads the room microphone mute state", async () => {
  webexResponder = (url) => {
    assert.match(url, /\/v1\/xapi\/status\?deviceId=dev-1&name=Audio\.Microphones\.Mute$/);
    return Response.json({ result: { Audio: { Microphones: { Mute: "On" } } } });
  };
  const res = await realFetch(`${base}/api/room-mic?deviceId=dev-1`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { muted: true });
});

test("POST /api/room-mic mutes and unmutes via xAPI commands", async () => {
  webexResponder = () => Response.json({ result: {} });
  for (const [muted, command] of [
    [true, "Audio.Microphones.Mute"],
    [false, "Audio.Microphones.Unmute"],
  ]) {
    webexCalls = [];
    const res = await realFetch(`${base}/api/room-mic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "dev-1=", muted }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { muted });
    assert.equal(webexCalls[0].url, `https://webexapis.com/v1/xapi/command/${command}`);
    assert.deepEqual(JSON.parse(webexCalls[0].init.body), { deviceId: "dev-1", arguments: {} });
  }
});

test("/api/room-mic validates input and reports Webex failures", async () => {
  assert.equal((await realFetch(`${base}/api/room-mic`)).status, 400);
  const bad = await realFetch(`${base}/api/room-mic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "dev-1", muted: "yes" }),
  });
  assert.equal(bad.status, 400);
  webexResponder = () => new Response("offline", { status: 502 });
  assert.equal((await realFetch(`${base}/api/room-mic?deviceId=dev-1`)).status, 502);
});
