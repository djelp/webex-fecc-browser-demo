/**
 * Room calling page: sign in with Webex (server-side OAuth session), dial a room by SIP URI,
 * render the call, and point the shared camera controls at the connected room.
 */
(function () {
  const ROOMS_REFRESH_MS = 30 * 1000;
  /** How often to re-read the room's mic state during a call (people in the room can change it). */
  const ROOM_MIC_REFRESH_MS = 5 * 1000;

  const els = {
    who: document.getElementById("who"),
    whoName: document.getElementById("whoName"),
    signOut: document.getElementById("signOut"),
    roomsMessage: document.getElementById("roomsMessage"),
    roomList: document.getElementById("roomList"),
    callLabel: document.getElementById("callLabel"),
    callSub: document.getElementById("callSub"),
    muteLabel: document.getElementById("muteLabel"),
    muteBtn: document.getElementById("muteBtn"),
    roomMicState: document.getElementById("roomMicState"),
    roomMicBtn: document.getElementById("roomMicBtn"),
    roomMicError: document.getElementById("roomMicError"),
    hangupBtn: document.getElementById("hangupBtn"),
    message: document.getElementById("message"),
    remoteVideo: document.getElementById("remoteVideo"),
    remoteAudio: document.getElementById("remoteAudio"),
    selfView: document.getElementById("selfView"),
    placeholder: document.getElementById("placeholder"),
  };

  /** @type {{ name: string, sipUri: string, deviceId: string, online: boolean }[]} */
  let rooms = [];
  let webex = null;
  let meeting = null;
  let activeRoom = null;
  let localStreams = null;

  const controls = createFeccControls({
    root: document.getElementById("controls"),
    statusEl: document.getElementById("status"),
    getDeviceId: () => activeRoom?.deviceId,
  });
  controls.setEnabled(false);

  function showMessage(text, kind) {
    els.message.textContent = text || "";
    els.message.className = kind || "";
    els.message.hidden = !text;
  }

  /** Signed-out visitors start at the sign-in page. */
  function goToSignIn() {
    location.replace("/login.html");
  }

  function setRoomsHint(text, isError) {
    els.roomsMessage.textContent = text;
    els.roomsMessage.className = isError ? "err" : "muted";
    els.roomsMessage.hidden = !text;
  }

  // ---- Rooms ----------------------------------------------------------------

  async function loadRooms() {
    try {
      const res = await fetch("/api/rooms");
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        if (!activeRoom) goToSignIn(); // never drop a live call; sign-in is asked for once it ends
        return;
      } else if (!res.ok) {
        throw new Error(data.error || res.statusText);
      } else {
        rooms = data;
        setRoomsHint(rooms.length ? "" : "No rooms — grant the bot Full access to the workspace in Control Hub.");
      }
    } catch (err) {
      rooms = [];
      setRoomsHint("Could not load rooms: " + (err.message || err), true);
    }
    renderRooms();
  }

  function renderRooms() {
    els.roomList.replaceChildren(
      ...rooms.map((room) => {
        const isActive = activeRoom?.deviceId === room.deviceId;
        const li = document.createElement("li");
        li.className = "room" + (isActive ? " active" : "");

        const top = document.createElement("div");
        top.className = "room-top";
        const name = document.createElement("span");
        name.className = "room-name";
        name.textContent = room.name;
        const pill = document.createElement("span");
        if (isActive) {
          pill.className = "pill active";
          pill.textContent = meeting ? "In call" : "Calling…";
        } else {
          pill.className = "pill" + (room.online ? " online" : "");
          const dot = document.createElement("span");
          dot.className = "dot";
          pill.append(dot, room.online ? "Online" : "Offline");
        }
        top.append(name, pill);

        const bottom = document.createElement("div");
        bottom.className = "room-bottom";
        const sip = document.createElement("span");
        sip.className = "room-sip";
        sip.textContent = room.sipUri;
        sip.title = room.sipUri;
        bottom.append(sip);
        if (!isActive) {
          const dial = document.createElement("button");
          dial.type = "button";
          dial.className = "btn btn-sm" + (room.online && webex && !activeRoom ? " btn-primary" : "");
          dial.textContent = "Dial";
          dial.disabled = !room.online || !webex || Boolean(activeRoom);
          dial.title = !room.online ? "Room is offline" : !webex ? "Sign in first" : "";
          dial.setAttribute("aria-label", "Dial " + room.name);
          dial.addEventListener("click", () => dialRoom(room));
          bottom.append(dial);
        }

        li.append(top, bottom);
        return li;
      })
    );
  }


  // ---- Sign-in ----------------------------------------------------------------

  /** Picks up the server-side Webex session (if any), starts the SDK with its token and loads rooms. */
  async function startSession() {
    let res;
    try {
      res = await fetch("/auth/session");
    } catch (err) {
      setRoomsHint("Could not reach the server.", true);
      return;
    }
    if (res.status === 503) {
      setRoomsHint("Webex sign-in is not configured on the server.", true);
      return;
    }
    if (!res.ok) {
      goToSignIn();
      return;
    }
    const { name, accessToken } = await res.json();
    els.who.hidden = false;
    els.whoName.textContent = "Signing in…";
    const candidate = window.Webex.init({ credentials: { access_token: accessToken } });
    try {
      // The SDK loads its internal plugins asynchronously; registering before "ready" fails.
      if (!candidate.ready) await new Promise((resolve) => candidate.once("ready", resolve));
      await candidate.meetings.register();
      candidate.meetings.on("meeting:removed", ({ meetingId }) => {
        if (meeting && meeting.id === meetingId) endCall("The call ended.");
      });
      webex = candidate;
    } catch (err) {
      console.error("Webex calling registration failed", err);
      showMessage("Signed in, but Webex calling could not start: " + (err?.message || err), "err");
    }
    els.whoName.textContent = "Signed in as " + name;
    await loadRooms();
    // Pick up newly granted workspaces and online/offline changes without a reload.
    setInterval(() => {
      if (!document.hidden) loadRooms();
    }, ROOMS_REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadRooms();
    });
  }

  async function signOut() {
    if (activeRoom) await hangUp();
    if (webex) {
      try {
        await webex.meetings.unregister();
      } catch (err) {
        console.error(err);
      }
    }
    webex = null;
    await fetch("/auth/logout", { method: "POST" }).catch(() => {});
    goToSignIn();
  }

  // ---- Calling ----------------------------------------------------------------

  function setCallUi(state, room) {
    const inCall = state !== "idle";
    els.hangupBtn.hidden = !inCall;
    els.muteBtn.hidden = state !== "connected";
    els.selfView.hidden = !inCall;
    els.placeholder.hidden = state === "connected";
    els.callLabel.textContent = inCall ? room.name : "Not in a call";
    els.callSub.textContent =
      state === "dialing" ? "Calling…" : state === "connected" ? "Connected" : "Choose a room to call";
    els.placeholder.textContent = state === "dialing" ? "Connecting…" : "Choose a room and click Dial.";
    els.muteLabel.textContent = "Mute me";
    renderRooms();
  }

  async function dialRoom(room) {
    if (!webex || activeRoom) return;
    showMessage("");
    activeRoom = room;
    setCallUi("dialing", room);

    const streams = {};
    try {
      const helpers = webex.meetings.mediaHelpers;
      streams.microphone = await helpers.createMicrophoneStream({ echoCancellation: true, noiseSuppression: true });
      streams.camera = await helpers.createCameraStream({ width: 1280, height: 720 });
    } catch (err) {
      console.error("Local media failed", err);
      stopStreams(streams);
      if (activeRoom === room) endCall("The browser blocked the camera or microphone. Allow access and try again.");
      return;
    }
    if (activeRoom !== room) {
      stopStreams(streams); // hung up while starting media
      return;
    }
    localStreams = streams;
    els.selfView.srcObject = localStreams.camera.outputStream;

    try {
      const created = await webex.meetings.create(room.sipUri);
      if (activeRoom !== room) return; // hung up while dialing
      meeting = created;
      meeting.on("media:ready", (media) => {
        if (media.type === "remoteVideo") els.remoteVideo.srcObject = media.stream;
        if (media.type === "remoteAudio") els.remoteAudio.srcObject = media.stream;
      });
      meeting.on("media:stopped", (media) => {
        if (media.type === "remoteVideo") els.remoteVideo.srcObject = null;
        if (media.type === "remoteAudio") els.remoteAudio.srcObject = null;
      });
      await meeting.joinWithMedia({
        joinOptions: { enableMultistream: false },
        mediaOptions: { localStreams, allowMediaInLobby: true },
      });
      if (meeting !== created) return; // ended while joining
      controls.setEnabled(true);
      startRoomMic(room);
      setCallUi("connected", room);
    } catch (err) {
      console.error("Call failed", err);
      await hangUp();
      showMessage("Call to " + room.name + " failed: " + (err?.message || err), "err");
    }
  }

  /** Leave the current meeting (if any) and reset the page. */
  async function hangUp() {
    const m = meeting;
    meeting = null;
    if (m) {
      try {
        await m.leave();
      } catch (err) {
        console.error("Leave failed", err);
      }
    }
    endCall();
  }

  function stopStreams(streams) {
    Object.values(streams).forEach((stream) => {
      try {
        stream?.stop();
      } catch {}
    });
  }

  /** Release local media and reset UI; `message` is shown when the call ended on its own. */
  function endCall(message) {
    meeting = null;
    activeRoom = null;
    controls.setEnabled(false);
    stopRoomMic();
    if (localStreams) {
      stopStreams(localStreams);
      localStreams = null;
    }
    els.remoteVideo.srcObject = null;
    els.remoteAudio.srcObject = null;
    els.selfView.srcObject = null;
    setCallUi("idle");
    if (message) showMessage(message, "err");
  }

  // ---- Room microphone (far end) ------------------------------------------------

  let roomMicTimer = null;
  /** @type {boolean | null} last known state; null = unknown */
  let roomMicMuted = null;

  function renderRoomMic() {
    const inCall = Boolean(activeRoom && meeting);
    els.roomMicBtn.disabled = !inCall || roomMicMuted === null;
    if (!inCall) {
      els.roomMicState.textContent = "Not in a call";
      els.roomMicState.className = "mic-state";
      els.roomMicBtn.textContent = "Mute room";
      return;
    }
    if (roomMicMuted === null) {
      els.roomMicState.textContent = "Checking…";
      els.roomMicState.className = "mic-state";
      return;
    }
    els.roomMicState.textContent = roomMicMuted ? "Muted" : "Live";
    els.roomMicState.className = "mic-state " + (roomMicMuted ? "muted" : "live");
    els.roomMicBtn.textContent = roomMicMuted ? "Unmute room" : "Mute room";
  }

  function showRoomMicError(text) {
    els.roomMicError.textContent = text || "";
    els.roomMicError.hidden = !text;
  }

  async function refreshRoomMic(room) {
    try {
      const res = await fetch("/api/room-mic?deviceId=" + encodeURIComponent(room.deviceId));
      const data = await res.json().catch(() => ({}));
      if (activeRoom !== room) return;
      if (!res.ok) throw new Error(data.error || res.statusText);
      roomMicMuted = data.muted;
      showRoomMicError("");
    } catch (err) {
      if (activeRoom === room) showRoomMicError(err.message || String(err));
    }
    renderRoomMic();
  }

  function startRoomMic(room) {
    stopRoomMic();
    renderRoomMic();
    refreshRoomMic(room);
    roomMicTimer = setInterval(() => {
      if (!document.hidden) refreshRoomMic(room);
    }, ROOM_MIC_REFRESH_MS);
  }

  function stopRoomMic() {
    clearInterval(roomMicTimer);
    roomMicTimer = null;
    roomMicMuted = null;
    showRoomMicError("");
    renderRoomMic();
  }

  async function toggleRoomMic() {
    const room = activeRoom;
    if (!room || roomMicMuted === null) return;
    const muted = !roomMicMuted;
    els.roomMicBtn.disabled = true;
    try {
      const res = await fetch("/api/room-mic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: room.deviceId, muted }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      if (activeRoom === room) roomMicMuted = data.muted;
      showRoomMicError("");
    } catch (err) {
      showRoomMicError(err.message || String(err));
    }
    renderRoomMic();
  }

  // ---- Wiring -------------------------------------------------------------------

  els.signOut.addEventListener("click", () => signOut());
  els.hangupBtn.addEventListener("click", () => hangUp());
  els.roomMicBtn.addEventListener("click", () => toggleRoomMic());
  els.muteBtn.addEventListener("click", () => {
    const mic = localStreams?.microphone;
    if (!mic) return;
    mic.setUserMuted(!mic.userMuted);
    els.muteLabel.textContent = mic.userMuted ? "Unmute me" : "Mute me";
  });
  window.addEventListener("pagehide", () => {
    if (meeting) meeting.leave().catch(() => {});
  });

  // Webex's API only allows browser (CORS) calls from HTTPS pages on a real hostname, never localhost.
  const originBlocked = location.protocol !== "https:" || /^(localhost|127\.|\[::1\])/.test(location.hostname);
  if (originBlocked) {
    setRoomsHint("");
    showMessage(
      "Webex blocks sign-in from " + location.origin + ". Open this page from its HTTPS address (for example the ngrok URL) instead.",
      "err"
    );
  } else if (!window.Webex) {
    setRoomsHint("");
    showMessage("The Webex SDK did not load. Check the internet connection and reload.", "err");
  } else {
    startSession();
  }
})();
