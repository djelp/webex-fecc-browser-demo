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
