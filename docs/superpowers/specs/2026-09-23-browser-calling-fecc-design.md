# Browser Calling + FECC — Design

**Date:** 2026-09-23
**Status:** Approved

## Goal

A single browser page where a user picks one of a fixed set of RoomOS devices (six dedicated rooms at a doctor's office), clicks **Dial**, sees the room's video, and drives the far-end camera from a panel beside the video. No Webex app, no bot DM, no room tab, no text chat.

## Scope

In:
- `GET /api/rooms` — directory built from the devices the bot can see.
- `call.html` page: token entry, room list, video, camera-control panel.
- Webex JS SDK calling by SIP URI, sending local camera/mic and rendering remote audio/video.
- `DM_TAB_ENABLED` switch so the device macro can stay installed but `/call` no longer DMs or creates tabs.
- Extract the existing press-and-hold control logic into a shared module used by both pages.

Out (for now):
- Guest calling (option C). Designed for, not built: a future `POST /api/guest-token` replaces the paste-token field; nothing else changes.
- Text chat, multiple simultaneous calls, room naming overrides, authentication for the page itself.

## User experience

1. Open `call.html` from the app's HTTPS address (e.g. the ngrok URL). Webex's API rejects CORS requests from `localhost` and plain-HTTP origins, so the page shows a warning when opened any other way.
2. First visit: paste a Webex access token. It is saved in this browser's `localStorage` until it fails or the user clicks **Change token**.
3. Left column: rooms, each with an online (green) / offline (grey) dot. Offline rooms have **Dial** disabled.
4. **Dial** → centre shows the room's video large, local self-view small in a corner, plus **Mute** and **Hang up**.
5. Right column: the existing arrows, zoom and speed sliders. Disabled until the call is connected; they target the connected room's device ID.
6. **Hang up** (or the far end ending the call) clears the video and disables the controls.

## Architecture

```
Browser (call.html)
 ├─ webex-call.js ──(Webex JS SDK, user token)──▶ Webex cloud ──SIP──▶ RoomOS device
 ├─ fecc-controls.js ──POST /api/fecc/command──▶ server.js ──(bot token) xAPI Camera.Ramp──▶ device
 └─ GET /api/rooms ──▶ server.js ──(bot token) GET /v1/devices──▶ Webex
```

### Server (`server.js`)

- **`GET /api/rooms`** — calls `GET https://webexapis.com/v1/devices` with the bot token. Returns items that have a `primarySipUrl`:
  `[{ name, sipUri, deviceId, online }]`, where `deviceId` has `=` padding stripped and `online` is `connectionStatus` starting with `connected`. Sorted by name. Upstream failure → `502 { error }`.
- **`DM_TAB_ENABLED`** env var. When `"false"`, `POST /call` logs and returns `204` without caching a person, sending a DM or creating a tab. Any other value (including unset) keeps today's behaviour. `.env` sets it to `false`.
- `/api/fecc/command`, `/startup`, `/call-end` unchanged.

### Page

- **`public/call.html`** — three-column layout (rooms | video | controls); stacks vertically on narrow screens. Loads the Webex SDK from the official CDN, then `fecc-controls.js` and `webex-call.js`.
- **`public/webex-call.js`** — owns the call:
  - `Webex.init({ credentials: { access_token } })`, `webex.meetings.register()`.
  - Dial: `webex.meetings.create(sipUri)`, then join with local audio+video and receive remote audio+video.
  - Attaches remote video/audio streams to `<video>`/`<audio>` elements and local video to the self-view.
  - Mute toggles local audio. Hang up leaves the meeting and releases local tracks.
  - Tells the controls which `deviceId` is active on connect and clears it on end.
- **`public/fecc-controls.js`** — the press-and-hold ramp logic and sliders moved out of `index.html`, exposed as `createFeccControls(rootElement, { getDeviceId })`. `index.html` uses it with the `?deviceId=` query value; `call.html` uses it with the connected room's ID. Behaviour (tap handling, pointer capture, status line) unchanged.

## Error handling

| Situation | Behaviour |
|---|---|
| Token rejected on register (401) | Clear saved token, show "Token invalid or expired — paste a new one", show token field. |
| `/api/rooms` fails | Message in the room column with the error. |
| `/api/rooms` returns empty | "No rooms — grant the bot Full access to the workspace in Control Hub." |
| Room offline | Dial disabled. |
| Dial / join fails, or call drops | Message above the video; return to idle state; controls disabled. |
| Camera/mic permission denied | Message explaining the browser blocked camera/mic; call not started. |
| FECC command fails | Existing status line under the controls; call continues. |

## Testing

- `curl localhost:3000/api/rooms` returns Room A with its SIP URI and `online: true`.
- `POST /call` with `DM_TAB_ENABLED=false` returns 204 and sends no DM.
- Existing `index.html?deviceId=…` still moves the camera (regression check for the extraction).
- End to end: paste token, dial Room A, see remote video, move the camera with each direction and zoom, hang up.
