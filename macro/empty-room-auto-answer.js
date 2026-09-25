/**
 * Empty-room auto-answer (RoomOS macro)
 *
 * Answers an incoming call ONLY when the device's people detection reports the
 * room as empty. If anyone is present — or presence cannot be determined — the
 * call rings normally so someone in the room can choose to accept it.
 *
 * - Never turns on the device's Conference > AutoAnswer setting; it accepts one
 *   call at a time with Call.Accept.
 * - Never answers while the device is already in another call.
 * - Re-checks presence immediately before answering.
 *
 * Enable / disable it from the Macro Editor to open or close a test window.
 */
import xapi from 'xapi';

// ---- Settings -------------------------------------------------------------------

/**
 * Who may be auto-answered. Empty = any caller.
 * Entries (case-insensitive):
 *   'spark:<webex-user-id>'   a Webex App / browser caller (see README for finding the ID)
 *   'room@partner.com'        a specific SIP URI
 *   '@partner.com'            any SIP URI in a domain
 */
const ALLOWED_CALLERS = [];

/** Let the call ring briefly before answering, so it is noticeable in the room. */
const ANSWER_DELAY_MS = 2000;

/** Turn on the people presence detector at start-up if it is off. */
const ENABLE_PRESENCE_DETECTOR = true;

// ---- Implementation --------------------------------------------------------------

const TAG = '[empty-room-auto-answer]';

function normalize(address) {
  return String(address || '')
    .trim()
    .toLowerCase()
    .replace(/^sip:/, '');
}

function callerAllowed(addresses) {
  if (ALLOWED_CALLERS.length === 0) return true;
  const candidates = addresses.map(normalize).filter(Boolean);
  return ALLOWED_CALLERS.some((entry) => {
    const rule = normalize(entry);
    if (rule.startsWith('@')) return candidates.some((a) => a.endsWith(rule));
    return candidates.includes(rule);
  });
}

/**
 * True only when the device positively reports nobody present.
 * PeoplePresence is "Yes" / "No"; PeopleCount.Current is -1 when counting is unavailable.
 */
async function roomIsEmpty() {
  const presence = await xapi.Status.RoomAnalytics.PeoplePresence.get().catch(() => null);
  const count = await xapi.Status.RoomAnalytics.PeopleCount.Current.get().catch(() => null);
  if (presence !== 'No') return false;
  return !(Number(count) > 0);
}

async function listCalls() {
  const calls = await xapi.Status.Call.get().catch(() => []);
  return Array.isArray(calls) ? calls : [];
}

async function handleIncomingCall(event) {
  const callId = event.CallId;
  const calls = await listCalls();
  const call = calls.find((c) => String(c.id) === String(callId));
  const addresses = [event.RemoteURI, call?.RemoteNumber, call?.CallbackNumber];

  if (!callerAllowed(addresses)) {
    console.log(TAG, 'Caller not in ALLOWED_CALLERS; letting it ring.');
    return;
  }
  if (calls.some((c) => String(c.id) !== String(callId) && c.Status === 'Connected')) {
    console.log(TAG, 'Already in a call; letting it ring.');
    return;
  }
  if (!(await roomIsEmpty())) {
    console.log(TAG, 'People present or presence unknown; letting it ring.');
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ANSWER_DELAY_MS));

  // Re-check: the call must still be ringing and the room still empty.
  const still = (await listCalls()).find((c) => String(c.id) === String(callId));
  if (!still || still.Status !== 'Ringing') {
    console.log(TAG, 'Call no longer ringing; nothing to do.');
    return;
  }
  if (!(await roomIsEmpty())) {
    console.log(TAG, 'Someone arrived; letting it ring.');
    return;
  }

  try {
    await xapi.Command.Call.Accept({ CallId: callId });
    console.log(TAG, 'Room empty: answered call', callId);
  } catch (err) {
    console.error(TAG, 'Call.Accept failed:', err.message || err);
  }
}

async function init() {
  if (ENABLE_PRESENCE_DETECTOR) {
    try {
      const mode = await xapi.Config.RoomAnalytics.PeoplePresenceDetector.get();
      if (mode !== 'On') {
        await xapi.Config.RoomAnalytics.PeoplePresenceDetector.set('On');
        console.log(TAG, 'Turned on RoomAnalytics PeoplePresenceDetector.');
      }
    } catch (err) {
      console.warn(TAG, 'Presence detector not available on this device; calls will always ring.', err.message || err);
    }
  }

  xapi.Event.IncomingCallIndication.on((event) => {
    handleIncomingCall(event).catch((err) => console.error(TAG, err.message || err));
  });

  console.log(TAG, 'Ready. Allowed callers:', ALLOWED_CALLERS.length ? ALLOWED_CALLERS.join(', ') : 'any');
}

init();
