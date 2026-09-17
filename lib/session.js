'use strict';

// Pure, socket-free session state machine.
//
// The v1 bug lived here in spirit: conductor identity was `socket.id`, which is
// regenerated on every reconnect. A screen lock or WiFi blip silently demoted
// the conductor, and `start-sync` then hit a `if (socket.id === conductorClient)`
// branch with no `else` — the button did nothing, forever, with no feedback.
//
// v2 fixes both halves: identity is a client-persisted `deviceId`, and every
// command returns an explicit ok/error result that the caller must surface.

const DEFAULT_CONDUCTOR_GRACE_MS = 30000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PIN_PATTERN = /^\d{4}$/;

function defaultPinFactory() {
  // 1000-9999 so it is always exactly 4 digits.
  return String(1000 + Math.floor(Math.random() * 9000));
}

function two(n) {
  return String(n).padStart(2, '0');
}

class SessionState {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.conductorGraceMs =
      options.conductorGraceMs === undefined
        ? DEFAULT_CONDUCTOR_GRACE_MS
        : options.conductorGraceMs;
    // When set (via SESSION_PIN), the PIN is fixed and every device must supply
    // it, including the first one. Otherwise the first device to join
    // establishes a random PIN and is told what it is.
    this.fixedPin = options.fixedPin || null;
    this.pinFactory = options.pinFactory || defaultPinFactory;
    this.reset();
  }

  reset() {
    this.devices = new Map(); // deviceId -> device record
    this.socketIndex = new Map(); // socketId -> deviceId
    this.conductorDeviceId = null;
    this.flashDeviceId = null;
    this.syncStarted = false;
    this.sessionId = this.now();
    this.pin = this.fixedPin; // null => not yet established
    this.captureCounter = 2;
  }

  setCaptureCounter(n) {
    if (Number.isInteger(n) && n >= 0) this.captureCounter = n;
  }

  // --- queries ---------------------------------------------------------

  // True when the session is already in its freshly-reset state.
  isPristine() {
    return (
      this.devices.size === 0 &&
      this.socketIndex.size === 0 &&
      this.conductorDeviceId === null &&
      this.flashDeviceId === null &&
      this.syncStarted === false &&
      this.pin === this.fixedPin
    );
  }

  onlineDevices() {
    return Array.from(this.devices.values()).filter((d) => d.socketId !== null);
  }

  onlineCount() {
    return this.onlineDevices().length;
  }

  getDevice(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  deviceIdForSocket(socketId) {
    return this.socketIndex.get(socketId) || null;
  }

  isConductor(deviceId) {
    return deviceId !== null && deviceId === this.conductorDeviceId;
  }

  roleOf(deviceId) {
    return this.isConductor(deviceId) ? 'conductor' : 'client';
  }

  conductorSocketId() {
    const device = this.conductorDeviceId
      ? this.devices.get(this.conductorDeviceId)
      : null;
    return device ? device.socketId : null;
  }

  flashCapableDevices() {
    return this.onlineDevices()
      .filter((d) => d.hasFlash)
      .map((d) => ({
        deviceId: d.deviceId,
        role: this.roleOf(d.deviceId),
        isFlashPhone: d.deviceId === this.flashDeviceId
      }));
  }

  // --- membership ------------------------------------------------------

  // Returns { ok: true, role, sessionId, syncStarted, pin?, replacedSocketId? }
  // or { ok: false, error, message }.
  join({ deviceId, pin, socketId, hasFlash = false } = {}) {
    if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
      return {
        ok: false,
        error: 'INVALID_DEVICE_ID',
        message: 'This phone sent a malformed device ID. Refresh the page.'
      };
    }
    if (typeof socketId !== 'string' || socketId.length === 0) {
      return {
        ok: false,
        error: 'INVALID_SOCKET',
        message: 'Connection is not ready yet. Try again.'
      };
    }

    const suppliedPin = pin === undefined || pin === null ? '' : String(pin).trim();
    const firstJoinOfSession = this.pin === null;

    if (firstJoinOfSession) {
      // Nobody has claimed this session yet: mint a PIN for the conductor.
      this.pin = this.pinFactory();
    } else if (suppliedPin !== this.pin) {
      return {
        ok: false,
        error: suppliedPin === '' ? 'PIN_REQUIRED' : 'BAD_PIN',
        message:
          suppliedPin === ''
            ? 'Enter the 4-digit session PIN shown on the conductor phone.'
            : 'That PIN does not match this session.'
      };
    }

    let replacedSocketId = null;
    let device = this.devices.get(deviceId);

    if (device) {
      // Same phone reconnecting (or a second tab). The caller closes the stale
      // socket; we keep its index entry so that its (late) disconnect event is
      // recognised as superseded and cannot demote the live connection.
      if (device.socketId && device.socketId !== socketId) {
        replacedSocketId = device.socketId;
      }
      device.socketId = socketId;
      device.hasFlash = Boolean(hasFlash);
      device.offlineSince = null;
      device.lastSeen = this.now();
    } else {
      device = {
        deviceId,
        socketId,
        hasFlash: Boolean(hasFlash),
        connectedAt: this.now(),
        lastSeen: this.now(),
        offlineSince: null
      };
      this.devices.set(deviceId, device);
    }

    this.socketIndex.set(socketId, deviceId);

    // Claim the conductor seat if it is vacant. If this device already holds it,
    // reconnecting silently restores it — the whole point of v2.
    if (this.conductorDeviceId === null) {
      this.conductorDeviceId = deviceId;
    }

    const result = {
      ok: true,
      deviceId,
      role: this.roleOf(deviceId),
      sessionId: this.sessionId,
      syncStarted: this.syncStarted,
      isFlashPhone: deviceId === this.flashDeviceId,
      totalClients: this.onlineCount(),
      replacedSocketId
    };
    // Only the conductor is told the PIN; clients had to know it to get here.
    if (result.role === 'conductor') result.pin = this.pin;
    return result;
  }

  setFlashCapability(deviceId, hasFlash) {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.hasFlash = Boolean(hasFlash);
    return true;
  }

  // Marks a socket offline. The conductor seat is NOT reassigned here; it is
  // held for `conductorGraceMs` so a screen lock or WiFi blip can reclaim it.
  disconnect(socketId) {
    const deviceId = this.socketIndex.get(socketId);
    if (!deviceId) return { deviceId: null, wasConductor: false };

    this.socketIndex.delete(socketId);
    const device = this.devices.get(deviceId);
    if (!device || device.socketId !== socketId) {
      // A superseded socket from the same device; current session is untouched.
      return { deviceId, wasConductor: false, superseded: true };
    }

    device.socketId = null;
    device.offlineSince = this.now();
    return {
      deviceId,
      wasConductor: this.isConductor(deviceId),
      superseded: false
    };
  }

  // Drops devices that stayed offline past the grace window and promotes a new
  // conductor if the old one never came back. Call periodically.
  reap() {
    const now = this.now();
    const removed = [];
    let promoted = null;
    let sessionReset = false;

    // Drop index entries left behind by superseded sockets whose device is gone.
    for (const [socketId, deviceId] of this.socketIndex.entries()) {
      if (!this.devices.has(deviceId)) this.socketIndex.delete(socketId);
    }

    for (const [deviceId, device] of this.devices.entries()) {
      if (device.socketId !== null) continue;
      if (now - device.offlineSince < this.conductorGraceMs) continue;
      this.devices.delete(deviceId);
      removed.push(deviceId);
      if (this.flashDeviceId === deviceId) this.flashDeviceId = null;
      if (this.conductorDeviceId === deviceId) this.conductorDeviceId = null;
    }

    if (this.conductorDeviceId === null) {
      const next = this.onlineDevices()[0];
      if (next) {
        this.conductorDeviceId = next.deviceId;
        promoted = next.deviceId;
      }
    }

    // Everyone is gone: start a clean session (and a fresh PIN) for next time.
    // Guarded by `isPristine()` so an idle server does not churn out a new
    // sessionId and PIN on every single reap tick.
    if (this.devices.size === 0 && !this.isPristine()) {
      const counter = this.captureCounter;
      this.reset();
      this.captureCounter = counter;
      sessionReset = true;
    }

    return { removed, promoted, sessionReset };
  }

  // --- commands (all ack-shaped) ---------------------------------------

  startSync(deviceId) {
    if (!this.isConductor(deviceId)) {
      return {
        ok: false,
        error: 'NOT_CONDUCTOR',
        message: 'Only the conductor phone can start sync.'
      };
    }
    if (this.syncStarted) {
      return {
        ok: false,
        error: 'ALREADY_SYNCED',
        message: 'Sync is already running for this session.'
      };
    }
    if (this.onlineCount() === 0) {
      return {
        ok: false,
        error: 'NO_DEVICES',
        message: 'No phones are connected.'
      };
    }
    this.syncStarted = true;
    return { ok: true, totalClients: this.onlineCount() };
  }

  triggerCapture(deviceId) {
    if (!this.isConductor(deviceId)) {
      return {
        ok: false,
        error: 'NOT_CONDUCTOR',
        message: 'Only the conductor phone can trigger a capture.'
      };
    }
    if (!this.syncStarted) {
      return {
        ok: false,
        error: 'NOT_SYNCED',
        message: 'Press START SYNC before capturing.'
      };
    }

    const timestamp = this.now();
    const d = new Date(timestamp);
    const counter = two(this.captureCounter);
    this.captureCounter += 1;
    const folderName =
      `${counter}_${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
      `_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}_${timestamp}`;

    return { ok: true, timestamp, sessionId: this.sessionId, folderName };
  }

  selectFlashPhone(deviceId, targetDeviceId) {
    if (!this.isConductor(deviceId)) {
      return {
        ok: false,
        error: 'NOT_CONDUCTOR',
        message: 'Only the conductor phone can pick the flash phone.'
      };
    }
    if (!targetDeviceId || targetDeviceId === 'none') {
      this.flashDeviceId = null;
      return { ok: true, flashDeviceId: null };
    }
    const target = this.devices.get(targetDeviceId);
    if (!target || target.socketId === null) {
      return {
        ok: false,
        error: 'UNKNOWN_DEVICE',
        message: 'That phone is no longer connected.'
      };
    }
    this.flashDeviceId = targetDeviceId;
    return { ok: true, flashDeviceId: targetDeviceId };
  }

  // Guards the presigned-upload endpoint: a public Render URL should not mint
  // S3 write URLs for anyone who finds it.
  authorizeUpload({ deviceId, pin } = {}) {
    if (this.pin === null) {
      return {
        ok: false,
        error: 'NO_SESSION',
        message: 'No capture session is active.'
      };
    }
    if (String(pin || '').trim() !== this.pin) {
      return { ok: false, error: 'BAD_PIN', message: 'Invalid session PIN.' };
    }
    if (!this.devices.has(deviceId)) {
      return {
        ok: false,
        error: 'UNKNOWN_DEVICE',
        message: 'This phone is not part of the session.'
      };
    }
    return { ok: true };
  }
}

module.exports = {
  SessionState,
  DEFAULT_CONDUCTOR_GRACE_MS,
  DEVICE_ID_PATTERN,
  PIN_PATTERN
};
