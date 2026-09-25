# Browser Calling + FECC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `call.html` page that lists the bot-visible rooms, dials one by SIP URI with the Webex JS SDK, shows the video, and drives the far-end camera from a side panel.

**Architecture:** `server.js` gains `GET /api/rooms` (bot token → `/v1/devices`) and a `DM_TAB_ENABLED` switch for `/call`, and exports `app` so tests can start it on a random port. The press-and-hold control logic moves from `index.html` into `public/fecc-controls.js`, shared by `index.html` and the new `call.html`. `public/webex-call.js` owns sign-in, dialing, media and hang-up.

**Tech Stack:** Node 25, Express 4, `node:test` (no new deps), Webex JS SDK `webex@3.12.0` UMD from `https://cdn.jsdelivr.net/npm/webex@3.12.0/umd/webex.min.js`.

Spec: `docs/superpowers/specs/2026-09-23-browser-calling-fecc-design.md`

## Global Constraints

- No new npm dependencies; tests use `node:test` + `node:assert/strict` + global `fetch`.
- Webex SDK pinned to `3.12.0`, loaded from jsdelivr.
- `DM_TAB_ENABLED`: only the string `false` (case-insensitive, trimmed) disables the DM/tab; unset keeps today's behaviour.
- `/api/rooms` item shape: `{ name, sipUri, deviceId, online }`; `deviceId` has `=` stripped; `online` = `connectionStatus` starts with `connected`; Room Navigators excluded; sorted by name.
- Token stored in `localStorage` key `fecc.webexToken`; all storage access wrapped in try/catch.
- Existing `index.html?deviceId=…` behaviour must not change.

---

### Task 1: Server — rooms endpoint, DM switch, testable app

**Files:**
- Modify: `server.js` (add `roomsFromDevices`, `dmTabEnabled`, `GET /api/rooms`, early return in `POST /call`, export `app`, guard `listen`)
- Modify: `package.json` (add `"test": "node --test"`)
- Modify: `.env` (add `DM_TAB_ENABLED=false`)
- Test: `test/server.test.js`

**Interfaces:**
- Produces: `GET /api/rooms` → `200 [{ name: string, sipUri: string, deviceId: string, online: boolean }]` or `502 { error }`; exports `app`, `roomsFromDevices(items)`.

- [ ] **Step 1: Write the failing tests** — `test/server.test.js`:

```js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.WEBEX_BOT_TOKEN = "test-bot-token";

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
```

Add to `package.json` scripts: `"test": "node --test"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `roomsFromDevices` / `app` are not exported (and importing `server.js` starts a listener on 3000).

- [ ] **Step 3: Implement in `server.js`**

After `webappTabContentUrl`, add:

```js
/** `/call` sends the DM + Camera Control tab unless DM_TAB_ENABLED is "false". */
function dmTabEnabled() {
  return (process.env.DM_TAB_ENABLED ?? "").trim().toLowerCase() !== "false";
}

/**
 * Callable rooms from a Webex /v1/devices list: devices with a SIP address, excluding Room Navigators.
 * @returns {{ name: string, sipUri: string, deviceId: string, online: boolean }[]}
 */
export function roomsFromDevices(items) {
  return (Array.isArray(items) ? items : [])
    .filter((d) => d?.id && typeof d.primarySipUrl === "string" && d.primarySipUrl && !/navigator/i.test(d.product ?? ""))
    .map((d) => ({
      name: d.displayName || d.primarySipUrl,
      sipUri: d.primarySipUrl,
      deviceId: stripIdPadding(d.id),
      online: String(d.connectionStatus ?? "").startsWith("connected"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

After the `/api/fecc/config` route, add:

```js
app.get("/api/rooms", async (req, res) => {
  if (!process.env.WEBEX_BOT_TOKEN) {
    return res.status(500).json({ error: "WEBEX_BOT_TOKEN is not configured" });
  }
  try {
    const devicesRes = await fetch("https://webexapis.com/v1/devices?max=1000", { headers });
    if (!devicesRes.ok) {
      const body = await devicesRes.text();
      console.error("GET /api/rooms - Webex devices API error", devicesRes.status, body);
      return res.status(502).json({ error: "Webex devices lookup failed" });
    }
    const data = await devicesRes.json();
    res.json(roomsFromDevices(data.items));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Webex devices lookup failed" });
  }
});
```

In `POST /call`, right after the two `console.log` lines:

```js
  if (!dmTabEnabled()) {
    console.log("POST /call: DM_TAB_ENABLED=false, skipping DM and Camera Control tab");
    return res.sendStatus(204);
  }
```

Replace the `app.listen(...)` block with:

```js
export { app };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}
```

and change the path import to `import { dirname, join, resolve } from "node:path";`.

Add `DM_TAB_ENABLED=false` to `.env` (below `PORT`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 5 passing.

- [ ] **Step 5: Live check**

Run: `PORT=3100 node server.js &` then `curl -s localhost:3100/api/rooms`
Expected: JSON array containing `{"name":"Room A","sipUri":"room-a@example.rooms.webex.com",…,"online":true}`. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add server.js package.json test/server.test.js
git commit -m "Add /api/rooms and DM_TAB_ENABLED switch; export app for tests"
```

---

### Task 2: Extract shared camera controls

**Files:**
- Create: `public/fecc-controls.js`
- Modify: `public/index.html` (replace inline ramp/slider logic with a call to `createFeccControls`)

**Interfaces:**
- Produces: global `window.createFeccControls({ root, statusEl, getDeviceId })` → `{ setEnabled(enabled: boolean): void }`. `root` must contain `button[data-direction]`, `#panSpeed`, `#tiltSpeed`, `#zoomSpeed`, `#panSpeedOut`, `#tiltSpeedOut`, `#zoomSpeedOut`. `getDeviceId()` returns the target device ID or a falsy value.

- [ ] **Step 1: Create `public/fecc-controls.js`**

```js
/**
 * Press-and-hold far-end camera controls (Camera.Ramp via POST /api/fecc/command).
 * @param {{ root: HTMLElement, statusEl: HTMLElement, getDeviceId: () => string | null | undefined }} options
 * @returns {{ setEnabled: (enabled: boolean) => void }}
 */
window.createFeccControls = function createFeccControls({ root, statusEl, getDeviceId }) {
  const buttons = root.querySelectorAll("button[data-direction]");
  const panSpeedEl = root.querySelector("#panSpeed");
  const tiltSpeedEl = root.querySelector("#tiltSpeed");
  const zoomSpeedEl = root.querySelector("#zoomSpeed");
  const panSpeedOut = root.querySelector("#panSpeedOut");
  const tiltSpeedOut = root.querySelector("#tiltSpeedOut");
  const zoomSpeedOut = root.querySelector("#zoomSpeedOut");

  function syncSliderLabels() {
    panSpeedOut.textContent = panSpeedEl.value;
    tiltSpeedOut.textContent = tiltSpeedEl.value;
    zoomSpeedOut.textContent = zoomSpeedEl.value;
  }
  [panSpeedEl, tiltSpeedEl, zoomSpeedEl].forEach((el) => el.addEventListener("input", syncSliderLabels));
  syncSliderLabels();

  function speedPayload() {
    return {
      panSpeed: Number(panSpeedEl.value),
      tiltSpeed: Number(tiltSpeedEl.value),
      zoomSpeed: Number(zoomSpeedEl.value),
    };
  }

  let rampStartPromise = null;
  let rampPointerDownAt = 0;
  /** Press shorter than this is treated as a tap: extra stop after start completes (avoids stop-before-start races). */
  const RAMP_TAP_MS = 300;

  function finishRamp(btn, e) {
    const p = rampStartPromise;
    if (!p) return;
    rampStartPromise = null;
    const holdMs = Date.now() - rampPointerDownAt;
    const isTap = holdMs < RAMP_TAP_MS;
    if (e && e.pointerId != null) {
      try {
        if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
    p.catch(() => {});
    sendRampStop().catch(() => {});
    if (isTap) {
      p.then(() => sendRampStop().catch(() => {}));
    }
  }

  async function sendRampStart(direction) {
    const res = await fetch("/api/fecc/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: getDeviceId(), action: "rampStart", direction, ...speedPayload() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusEl.className = "err";
      statusEl.textContent = data.error || res.statusText || "Ramp start failed";
      throw new Error(data.error || "rampStart failed");
    }
    statusEl.className = "ok";
    statusEl.textContent =
      "Ramp " + direction + " · pan " + data.panSpeed + " / tilt " + data.tiltSpeed + " / zoom " + data.zoomSpeed;
  }

  async function sendRampStop() {
    const deviceId = getDeviceId();
    if (!deviceId) return;
    const res = await fetch("/api/fecc/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, action: "rampStop", ...speedPayload() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusEl.className = "err";
      statusEl.textContent = data.error || res.statusText || "Ramp stop failed";
      return;
    }
    statusEl.className = "ok";
    statusEl.textContent = "Ramp stopped";
  }

  buttons.forEach((btn) => {
    const direction = btn.getAttribute("data-direction");

    btn.addEventListener("pointerdown", (e) => {
      if (!getDeviceId() || btn.disabled || e.button !== 0) return;
      e.preventDefault();
      if (rampStartPromise) return;
      rampPointerDownAt = Date.now();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (_) {}
      rampStartPromise = sendRampStart(direction).catch(() => {});
    });

    btn.addEventListener("pointerup", (e) => finishRamp(btn, e));
    btn.addEventListener("pointercancel", (e) => finishRamp(btn, e));
    btn.addEventListener("lostpointercapture", (e) => finishRamp(btn, e));
  });

  return {
    setEnabled(enabled) {
      buttons.forEach((b) => (b.disabled = !enabled));
      if (!enabled) {
        rampStartPromise = null;
        statusEl.className = "";
        statusEl.textContent = "";
      }
    },
  };
};
```

- [ ] **Step 2: Rewire `public/index.html`**

Wrap the `.panel` div and `#status` so the controls root is `document.body` (both are body descendants — no markup change needed). Replace everything in the inline `<script>` from `const buttons = …` down to the end of the `buttons.forEach(...)` block with:

```js
        const controls = createFeccControls({
          root: document.body,
          statusEl,
          getDeviceId: () => deviceId,
        });

        fetch("/api/fecc/config").catch(() => {});

        if (deviceId) {
          const short =
            deviceId.length > 28 ? deviceId.slice(0, 14) + "…" + deviceId.slice(-10) : deviceId;
          deviceLine.textContent = "Device: " + short;
        } else {
          missingWarn.hidden = false;
          controls.setEnabled(false);
        }
```

keeping the browser-info `console.log`, `params`, `deviceId`, `deviceLine`, `missingWarn` and `statusEl` declarations. Add `<script src="/fecc-controls.js"></script>` immediately before the inline `<script>`.

- [ ] **Step 3: Regression check in a browser**

Run the server on 3100, open `http://localhost:3100/` → buttons disabled, warning shown. Open `http://localhost:3100/?deviceId=<Room A deviceId from /api/rooms>` → slider labels update when dragged; a press on "→" sends `POST /api/fecc/command` with `action: "rampStart"` then `rampStop` (check network log); no console errors.

- [ ] **Step 4: Commit**

```bash
git add public/fecc-controls.js public/index.html
git commit -m "Extract camera controls into shared fecc-controls.js"
```

---

### Task 3: Calling page

**Files:**
- Create: `public/call.html`
- Create: `public/webex-call.js`

**Interfaces:**
- Consumes: `GET /api/rooms` (Task 1); `window.createFeccControls` (Task 2); `window.Webex` from the SDK UMD.
- Webex SDK calls used: `Webex.init({ credentials: { access_token } })`, `webex.people.get("me")`, `webex.meetings.register()`, `webex.meetings.mediaHelpers.createMicrophoneStream(opts)`, `…createCameraStream(opts)`, `webex.meetings.create(sipUri)`, `meeting.on("media:ready" | "media:stopped")`, `meeting.joinWithMedia({ joinOptions, mediaOptions: { localStreams, allowMediaInLobby } })`, `meeting.leave()`, `webex.meetings.on("meeting:removed")`, `stream.setUserMuted(bool)`, `stream.userMuted`, `stream.outputStream`, `stream.stop()`.

- [ ] **Step 1: Create `public/call.html`** — three columns (rooms | stage | controls), stacking below 900px; token form in the rooms column; stage has remote `<video>`, hidden `<audio>`, self-view `<video muted>`, placeholder text, Mute and Hang up; controls column reuses the index.html control markup and ids (`data-direction` buttons, `#panSpeed`…`#zoomSpeedOut`, `#status`). Scripts: SDK (pinned), `/fecc-controls.js`, `/webex-call.js`. (Full file in the commit.)

- [ ] **Step 2: Create `public/webex-call.js`** — IIFE that:
  1. Creates controls with `getDeviceId: () => activeRoom?.deviceId`, disabled.
  2. Loads `/api/rooms` on page load; renders each room with online dot, name, SIP URI, and a **Dial** button enabled only when `online && webex && !meeting`; empty list → "No rooms — grant the bot Full access to the workspace in Control Hub."; failure → error text.
  3. Reads token from `localStorage["fecc.webexToken"]`; if present, signs in; else shows the token form. Sign-in = `Webex.init` → `people.get("me")` → `meetings.register()`; success saves token and shows "Signed in as <name>"; 401 clears token and shows "Token invalid or expired — paste a new one."
  4. Dial: create mic+camera streams (failure → "The browser blocked the camera or microphone…"), show self-view, `meetings.create(sipUri)`, wire `media:ready`/`media:stopped` to the remote video/audio elements, `joinWithMedia`, then set `activeRoom`, enable controls, show "Connected to <name>".
  5. Hang up / `meeting:removed` for the active meeting / join failure: leave (if needed), stop local streams, clear video elements, disable controls, back to idle with a message when not user-initiated.
  6. Mute toggles `microphone.setUserMuted(!microphone.userMuted)` and relabels the button.
  7. **Change token** clears the saved token, hangs up if needed, and shows the token form.
  8. `pagehide` → `meeting.leave()`.

- [ ] **Step 3: Browser check (no call)**

Open `http://localhost:3100/call.html` → Room A listed with green dot, Dial disabled until signed in; bad token shows the invalid-token message; valid token (from `.env` `WEBEX_CALLER_TOKEN`) shows "Signed in as Darren Lapierre" and enables Dial; camera controls disabled; no console errors.

- [ ] **Step 4: End-to-end (user)**

Restart the user's server (`npm start`), open `http://localhost:3000/call.html`, dial Room A, confirm remote video + audio, press each direction and zoom, hang up; confirm no bot DM arrives.

- [ ] **Step 5: Commit**

```bash
git add public/call.html public/webex-call.js
git commit -m "Add browser calling page with Webex SDK and side camera controls"
```
