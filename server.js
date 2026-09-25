import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createAuth } from "./auth.js";

/** @type {Record<string, { deviceId?: string, lastPersonId?: string, directRoomId?: string }>} */
const deviceCache = Object.create(null);
const headers = { Authorization: `Bearer ${process.env.WEBEX_BOT_TOKEN}`, "Content-Type": "application/json" };

/** Webex sometimes returns base64-style ids with `=` padding; strip for consistent API use. */
function stripIdPadding(id) {
  return typeof id === "string" ? id.replaceAll("=", "") : id;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Ensures deviceSerial is present in deviceCache with deviceId, fetching from Webex if needed.
 * @throws {{ statusCode: number, message: string }} on failure
 */
async function ensureDeviceCached(deviceSerial) {
  if (typeof deviceSerial !== "string" || deviceSerial.length === 0) {
    throw { statusCode: 400, message: "deviceSerial is required" };
  }
  if (deviceCache[deviceSerial]?.deviceId) {
    return;
  }
  const devicesRes = await fetch(`https://webexapis.com/v1/devices?serial=${deviceSerial}`, { headers });
  if (!devicesRes.ok) {
    const body = await devicesRes.text();
    console.error("Webex devices API error", devicesRes.status, body);
    throw { statusCode: 502, message: "Webex devices lookup failed" };
  }
  const data = await devicesRes.json();
  let deviceId;
  if (Array.isArray(data.items) && data.items[0]?.id) {
    deviceId = data.items[0].id;
  } else {
    throw { statusCode: 404, message: "No device id in Webex response" };
  }
  if (!deviceCache[deviceSerial]) {
    deviceCache[deviceSerial] = {};
  }
  deviceCache[deviceSerial].deviceId = stripIdPadding(deviceId);
}

/**
 * Lists direct messages with the bot for `lastPersonId` and deletes any whose sender is not that person.
 * @param {string} lastPersonId
 * @throws {{ statusCode: number, message: string }}
 */
async function purgeDirectMessagesNotFromPerson(lastPersonId) {
  const listRes = await fetch(`https://webexapis.com/v1/messages/direct?personId=${lastPersonId}`, { headers });
  if (!listRes.ok) {
    const body = await listRes.text();
    console.error("purgeDirectMessagesNotFromPerson - Webex list direct messages error", listRes.status, body);
    throw { statusCode: 502, message: "Webex direct messages lookup failed" };
  }
  const data = await listRes.json();
  const items = Array.isArray(data.items) ? data.items : [];
  for (const item of items) {
    if (stripIdPadding(item.personId) !== stripIdPadding(lastPersonId)) {
      const delRes = await fetch(`https://webexapis.com/v1/messages/${item.id}`, { method: "DELETE", headers });
      if (!delRes.ok) {
        const delBody = await delRes.text();
        console.error("purgeDirectMessagesNotFromPerson - Webex delete message error", delRes.status, item.id, delBody);
        console.error("lastPersonId:", lastPersonId);
        console.error(item);
      } else {
        console.log("purgeDirectMessagesNotFromPerson - Deleted message:", item.id);
      }
    }
  }
}

function sendHttpError(res, err) {
  const code = err.statusCode ?? 500;
  if (code >= 500) {
    console.error(err.message);
  }
  res.status(code).json({ error: err.message });
}

const CAMERA_CONTROL_TAB_DISPLAY_NAME = "Camera Control";

/** Base URL for the Camera Control tab (no trailing slash). */
function webappPublicBaseUrl() {
  return (process.env.WEBAPP_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
}

function webappTabContentUrl(deviceId) {
  return `${webappPublicBaseUrl()}/?deviceId=${deviceId}`;
}

/** `/call` sends the DM + Camera Control tab unless DM_TAB_ENABLED is "false". */
function dmTabEnabled() {
  return (process.env.DM_TAB_ENABLED ?? "").trim().toLowerCase() !== "false";
}

/** Webex device ids decode to `ciscospark://urn:TEAM:<region>/DEVICE/<uuid>`; accessories use `/PERIPHERAL/`. */
function isPeripheral(id) {
  try {
    return Buffer.from(id, "base64").toString("utf8").includes("/PERIPHERAL/");
  } catch {
    return false;
  }
}

/**
 * Callable rooms from a Webex /v1/devices list: devices with a SIP address, excluding accessories
 * (Room Navigators, ceiling microphones and other peripherals that share the workspace SIP address).
 * @returns {{ name: string, sipUri: string, deviceId: string, online: boolean }[]}
 */
export function roomsFromDevices(items) {
  return (Array.isArray(items) ? items : [])
    .filter(
      (d) =>
        d?.id &&
        typeof d.primarySipUrl === "string" &&
        d.primarySipUrl &&
        !isPeripheral(d.id) &&
        !/navigator/i.test(d.product ?? "")
    )
    .map((d) => ({
      name: d.displayName || d.primarySipUrl,
      sipUri: d.primarySipUrl,
      deviceId: stripIdPadding(d.id),
      online: String(d.connectionStatus ?? "").startsWith("connected"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Posts "Camera Controller" to the person. Webex reuses an existing 1:1 or creates one; response includes roomId.
 * @see https://developer.webex.com/messaging/docs/api/v1/messages/create-a-message
 * @param {string} webexPersonId
 * @returns {Promise<string>}
 */
async function sendCameraControllerDmAndGetRoomId(webexPersonId) {
  const createRes = await fetch("https://webexapis.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      toPersonId: webexPersonId,
      markdown: "Camera Controller",
    }),
  });
  if (!createRes.ok) {
    const createText = await createRes.text();
    console.error("Camera Controller message error", createRes.status, createText);
    throw { statusCode: 502, message: "Webex create message failed" };
  }
  const created = await createRes.json();
  if (typeof created.roomId !== "string" || !created.roomId) {
    throw { statusCode: 502, message: "Webex message response missing roomId" };
  }
  return stripIdPadding(created.roomId);
}

/**
 * @param {string} roomId
 * @see https://developer.webex.com/messaging/docs/api/v1/room-tabs/list-room-tabs
 * @see https://developer.webex.com/messaging/docs/api/v1/room-tabs/delete-a-room-tab
 */
async function deleteCameraControlRoomTabs(roomId) {
  const listRes = await fetch(`https://webexapis.com/v1/room/tabs?roomId=${roomId}`, { headers });
  if (!listRes.ok) {
    const listText = await listRes.text();
    console.error("List room tabs error", listRes.status, listText);
    throw { statusCode: 502, message: "Webex list room tabs failed" };
  }
  const listData = await listRes.json();
  const tabs = Array.isArray(listData.items) ? listData.items : [];
  for (const tab of tabs) {
    if (tab?.displayName === CAMERA_CONTROL_TAB_DISPLAY_NAME && tab?.id) {
      const delRes = await fetch(`https://webexapis.com/v1/room/tabs/${tab.id}`, { method: "DELETE", headers });
      if (!delRes.ok) {
        const delBody = await delRes.text();
        console.error("Delete room tab error", delRes.status, tab.id, delBody);
        throw { statusCode: 502, message: "Webex delete room tab failed" };
      }
    }
  }
}

/**
 * Remove any tab named Camera Control, then add one pointing at the web app.
 * @see https://developer.webex.com/messaging/docs/api/v1/room-tabs/create-a-room-tab
 */
async function replaceCameraControlRoomTab(roomId, contentUrl) {
  await deleteCameraControlRoomTabs(roomId);

  const createRes = await fetch("https://webexapis.com/v1/room/tabs", { method: "POST", headers, body: JSON.stringify({ roomId, displayName: CAMERA_CONTROL_TAB_DISPLAY_NAME, contentUrl }) });
  const createText = await createRes.text();
  if (!createRes.ok) {
    console.error("Create room tab error", createRes.status, createText);
    throw { statusCode: 502, message: "Webex create room tab failed" };
  }
}

/** Camera.Ramp speeds: PanSpeed/TiltSpeed 1–24, ZoomSpeed 1–15 (RoomOS / Webex xAPI). */
const RAMP_SPEED_DEFAULT = { panSpeed: 12, tiltSpeed: 12, zoomSpeed: 8 };

function feccRampSpeedsFromWebBody(body) {
  const clamp = (v, lo, hi, def) => {
    const x = Math.round(Number(v));
    if (!Number.isFinite(x)) return def;
    return Math.min(hi, Math.max(lo, x));
  };
  return {
    panSpeed: clamp(body?.panSpeed, 1, 24, RAMP_SPEED_DEFAULT.panSpeed),
    tiltSpeed: clamp(body?.tiltSpeed, 1, 24, RAMP_SPEED_DEFAULT.tiltSpeed),
    zoomSpeed: clamp(body?.zoomSpeed, 1, 15, RAMP_SPEED_DEFAULT.zoomSpeed),
  };
}

function buildCameraRampArguments(direction, speeds) {
  const args = {
    CameraId: 1,
    Pan: "Stop",
    PanSpeed: speeds.panSpeed,
    Tilt: "Stop",
    TiltSpeed: speeds.tiltSpeed,
    Zoom: "Stop",
    ZoomSpeed: speeds.zoomSpeed,
  };
  switch (direction) {
    case "left":
      args.Pan = "Left";
      break;
    case "right":
      args.Pan = "Right";
      break;
    case "up":
      args.Tilt = "Up";
      break;
    case "down":
      args.Tilt = "Down";
      break;
    case "zoom-in":
      args.Zoom = "In";
      break;
    case "zoom-out":
      args.Zoom = "Out";
      break;
    default:
      return null;
  }
  return args;
}

function buildCameraRampStopArguments(speeds) {
  return {
    CameraId: 1,
    Pan: "Stop",
    PanSpeed: speeds.panSpeed,
    Tilt: "Stop",
    TiltSpeed: speeds.tiltSpeed,
    Zoom: "Stop",
    ZoomSpeed: speeds.zoomSpeed,
  };
}

async function postCameraRamp(deviceId, rampArguments) {
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
    throw { statusCode: 400, message: "deviceId is required" };
  }
  const normalizedDeviceId = stripIdPadding(deviceId.trim());
  const commandRes = await fetch("https://webexapis.com/v1/xapi/command/Camera.Ramp", {
    method: "POST",
    headers,
    body: JSON.stringify({ deviceId: normalizedDeviceId, arguments: rampArguments }),
  });
  if (!commandRes.ok) {
    const errText = await commandRes.text();
    console.error("Camera.Ramp error", commandRes.status, errText);
    throw { statusCode: 502, message: "Camera.Ramp failed" };
  }
}

const app = express();
const port = Number(process.env.PORT) || 3000;

const { router: authRouter, requireSession } = createAuth();

app.use(express.json());
app.use("/img", express.static(join(__dirname, "img")));
app.use(authRouter);

app.get("/api/fecc/config", (req, res) => {
  res.json({
    rampPanSpeedMax: 24,
    rampTiltSpeedMax: 24,
    rampZoomSpeedMax: 15,
  });
});

app.get("/api/rooms", requireSession, async (req, res) => {
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

app.post("/api/fecc/command", requireSession, async (req, res) => {
  if (!process.env.WEBEX_BOT_TOKEN) {
    return res.status(500).json({ error: "WEBEX_BOT_TOKEN is not configured" });
  }
  const body = req.body ?? {};
  const { deviceId } = body;
  try {
    const action = body.action;
    if (action === "rampStart") {
      const direction = typeof body.direction === "string" ? body.direction.trim().toLowerCase() : "";
      const speeds = feccRampSpeedsFromWebBody(body);
      const rampArgs = buildCameraRampArguments(direction, speeds);
      if (!rampArgs) {
        return res.status(400).json({ error: "Unsupported direction for ramp" });
      }
      await postCameraRamp(deviceId, rampArgs);
      return res.json({
        ok: true,
        action: "rampStart",
        direction,
        panSpeed: speeds.panSpeed,
        tiltSpeed: speeds.tiltSpeed,
        zoomSpeed: speeds.zoomSpeed,
      });
    }
    if (action === "rampStop") {
      const speeds = feccRampSpeedsFromWebBody(body);
      await postCameraRamp(deviceId, buildCameraRampStopArguments(speeds));
      return res.json({ ok: true, action: "rampStop" });
    }
    return res.status(400).json({ error: 'Expected action "rampStart" or "rampStop"' });
  } catch (err) {
    if (err && typeof err.statusCode === "number" && err.message) {
      return sendHttpError(res, err);
    }
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

/** Room microphone mute state: xStatus Audio Microphones Mute ("On" = muted). */
app.get("/api/room-mic", requireSession, async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? stripIdPadding(req.query.deviceId.trim()) : "";
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  try {
    const statusRes = await fetch(
      `https://webexapis.com/v1/xapi/status?deviceId=${encodeURIComponent(deviceId)}&name=Audio.Microphones.Mute`,
      { headers }
    );
    if (!statusRes.ok) {
      console.error("Room mic status error", statusRes.status, await statusRes.text());
      return res.status(502).json({ error: "Could not read the room microphone" });
    }
    const data = await statusRes.json();
    res.json({ muted: data?.result?.Audio?.Microphones?.Mute === "On" });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not read the room microphone" });
  }
});

/** Mutes or unmutes the room microphones: body { deviceId, muted: boolean }. */
app.post("/api/room-mic", requireSession, async (req, res) => {
  const { deviceId, muted } = req.body ?? {};
  if (typeof deviceId !== "string" || !deviceId.trim() || typeof muted !== "boolean") {
    return res.status(400).json({ error: "deviceId and muted (boolean) are required" });
  }
  const command = muted ? "Audio.Microphones.Mute" : "Audio.Microphones.Unmute";
  try {
    const commandRes = await fetch(`https://webexapis.com/v1/xapi/command/${command}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ deviceId: stripIdPadding(deviceId.trim()), arguments: {} }),
    });
    if (!commandRes.ok) {
      console.error(`${command} error`, commandRes.status, await commandRes.text());
      return res.status(502).json({ error: muted ? "Could not mute the room" : "Could not unmute the room" });
    }
    res.json({ muted });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: muted ? "Could not mute the room" : "Could not unmute the room" });
  }
});

function handleDeviceSerialCachePost(routeLabel) {
  return async (req, res) => {
    console.log(`POST ${routeLabel}:`);
    console.log(req.body);
    const { deviceSerial } = req.body ?? {};
    const hadCachedDevice = Boolean(deviceCache[deviceSerial]?.deviceId);
    if (hadCachedDevice) {
      const lastPersonId = deviceCache[deviceSerial]?.lastPersonId;
      if (lastPersonId) {
        try {
          await purgeDirectMessagesNotFromPerson(lastPersonId);
        } catch (err) {
          return sendHttpError(res, err);
        }
      }
    } else {
      try {
        await ensureDeviceCached(deviceSerial);
      } catch (err) {
        return sendHttpError(res, err);
      }
    }
    const entry = deviceCache[deviceSerial];
    try {
      const roomId = entry?.directRoomId ?? null;
      if (roomId) {
        await deleteCameraControlRoomTabs(roomId);
        console.log(`${routeLabel}: removed Camera Control tab for room`, roomId);
      }
    } catch (err) {
      if (err && typeof err.statusCode === "number" && err.message) {
        return sendHttpError(res, err);
      }
      console.error(err);
      return res.sendStatus(500);
    }
    res.sendStatus(204);
  };
}

app.post("/startup", handleDeviceSerialCachePost("/startup"));
app.post("/call-end", handleDeviceSerialCachePost("/call-end"));

app.post("/call", async (req, res) => {
  console.log("POST /call:");
  console.log(req.body);
  if (!dmTabEnabled()) {
    console.log("POST /call: DM_TAB_ENABLED=false, skipping DM and Camera Control tab");
    return res.sendStatus(204);
  }
  const { callbackNumber, deviceSerial } = req.body ?? {};
  try {
    await ensureDeviceCached(deviceSerial);
  } catch (err) {
    return sendHttpError(res, err);
  }
  const sparkPrefix = "spark:";
  if (typeof callbackNumber !== "string" || !callbackNumber.startsWith(sparkPrefix)) {
    return res.sendStatus(400);
  }
  const id = callbackNumber.slice(sparkPrefix.length);
  const uri = `ciscospark://us/PEOPLE/${id}`;
  const webexPersonId = Buffer.from(uri, "utf8").toString("base64").replaceAll("=", "");
  const entry = deviceCache[deviceSerial];
  entry.lastPersonId = webexPersonId;
  console.log("POST /call webexPersonId:", webexPersonId);

  const roomDeviceId = deviceCache[deviceSerial].deviceId;

  try {
    const roomId = await sendCameraControllerDmAndGetRoomId(webexPersonId);
    entry.directRoomId = roomId;
    const contentUrl = webappTabContentUrl(roomDeviceId);
    console.log("POST /call: roomId", roomId, "tab URL", contentUrl);
    await replaceCameraControlRoomTab(roomId, contentUrl);
  } catch (err) {
    if (err && typeof err.statusCode === "number" && err.message) {
      return sendHttpError(res, err);
    }
    console.error(err);
    return res.sendStatus(500);
  }

  res.sendStatus(204);
});

app.use(express.static(join(__dirname, "public")));

export { app };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}

