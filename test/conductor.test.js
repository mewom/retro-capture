'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionState } = require('../lib/session');

// Deterministic clock so grace-window behaviour is testable without sleeping.
function makeSession(overrides = {}) {
  let clock = 1_700_000_000_000;
  const session = new SessionState({
    now: () => clock,
    conductorGraceMs: 30_000,
    pinFactory: () => '4242',
    ...overrides
  });
  session.advance = (ms) => {
    clock += ms;
  };
  return session;
}

const A = 'device-aaaaaaaa';
const B = 'device-bbbbbbbb';
const C = 'device-cccccccc';

test('first phone to join becomes conductor and receives the PIN', () => {
  const s = makeSession();
  const res = s.join({ deviceId: A, socketId: 'sock-1' });

  assert.equal(res.ok, true);
  assert.equal(res.role, 'conductor');
  assert.equal(res.pin, '4242', 'conductor is told the PIN so it can share it');
  assert.equal(s.conductorDeviceId, A);
});

test('a second phone must supply the PIN and is never told it', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });

  const missing = s.join({ deviceId: B, socketId: 'sock-2' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'PIN_REQUIRED');

  const wrong = s.join({ deviceId: B, socketId: 'sock-2', pin: '0000' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'BAD_PIN');

  const good = s.join({ deviceId: B, socketId: 'sock-2', pin: '4242' });
  assert.equal(good.ok, true);
  assert.equal(good.role, 'client');
  assert.equal(good.pin, undefined, 'clients are not handed the PIN');
});

test('SESSION_PIN forces even the first phone to authenticate', () => {
  const s = makeSession({ fixedPin: '1357' });

  assert.equal(s.join({ deviceId: A, socketId: 'sock-1' }).ok, false);
  const ok = s.join({ deviceId: A, socketId: 'sock-1', pin: '1357' });
  assert.equal(ok.ok, true);
  assert.equal(ok.role, 'conductor');
});

test('malformed device IDs are rejected rather than silently accepted', () => {
  const s = makeSession();
  for (const bad of ['', 'short', null, 42, 'has spaces in it']) {
    const res = s.join({ deviceId: bad, socketId: 'sock-1' });
    assert.equal(res.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.equal(res.error, 'INVALID_DEVICE_ID');
  }
});

// === THE v1 REGRESSION ===============================================

test('REGRESSION: reconnecting with a new socket keeps conductor status', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.join({ deviceId: B, socketId: 'sock-2', pin: '4242' });

  // Screen lock: the conductor's socket dies.
  const dropped = s.disconnect('sock-1');
  assert.equal(dropped.wasConductor, true);
  assert.equal(s.conductorDeviceId, A, 'seat is held, not reassigned immediately');

  // It comes back seconds later with a brand-new socket.id.
  s.advance(5_000);
  const rejoin = s.join({ deviceId: A, socketId: 'sock-1-NEW', pin: '4242' });

  assert.equal(rejoin.ok, true);
  assert.equal(rejoin.role, 'conductor', 'v1 handed this phone "client" and broke sync');
  assert.equal(s.conductorSocketId(), 'sock-1-NEW');
});

test('REGRESSION: START SYNC works after a conductor reconnect', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.join({ deviceId: B, socketId: 'sock-2', pin: '4242' });

  s.disconnect('sock-1');
  s.advance(3_000);
  s.join({ deviceId: A, socketId: 'sock-1-NEW', pin: '4242' });

  const sync = s.startSync(A);
  assert.equal(sync.ok, true, 'this is the button that silently did nothing in v1');
  assert.equal(s.syncStarted, true);
});

test('REGRESSION: a non-conductor gets an explicit error, not silence', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.join({ deviceId: B, socketId: 'sock-2', pin: '4242' });

  const res = s.startSync(B);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NOT_CONDUCTOR');
  assert.match(res.message, /conductor/i, 'the phone can show this to the user');
  assert.equal(s.syncStarted, false);
});

// === conductor handover ==============================================

test('conductor is reassigned only after the grace window expires', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.join({ deviceId: B, socketId: 'sock-2', pin: '4242' });
  s.disconnect('sock-1');

  s.advance(29_000);
  assert.equal(s.reap().promoted, null, 'still inside the grace window');
  assert.equal(s.conductorDeviceId, A);

  s.advance(2_000);
  const reaped = s.reap();
  assert.equal(reaped.promoted, B, 'conductor never came back; B takes over');
  assert.equal(s.conductorDeviceId, B);
  assert.deepEqual(reaped.removed, [A]);
});

test('a reconnect inside the grace window cancels the handover', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.join({ deviceId: B, socketId: 'sock-2', pin: '4242' });

  s.disconnect('sock-1');
  s.advance(10_000);
  s.join({ deviceId: A, socketId: 'sock-1-NEW', pin: '4242' });

  s.advance(60_000);
  assert.equal(s.reap().promoted, null);
  assert.equal(s.conductorDeviceId, A, 'A is online again, so it keeps the seat');
});

test('a duplicate connection from one phone supersedes its old socket', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });

  const again = s.join({ deviceId: A, socketId: 'sock-2', pin: '4242' });
  assert.equal(again.replacedSocketId, 'sock-1', 'server should close the stale socket');
  assert.equal(s.onlineCount(), 1, 'one phone, not two ghosts');

  // The late disconnect of the dead socket must not demote the live one.
  const late = s.disconnect('sock-1');
  assert.equal(late.superseded, true);
  assert.equal(s.conductorSocketId(), 'sock-2');
  assert.equal(s.onlineCount(), 1);
});

test('the session fully resets once every phone is gone', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.startSync(A);
  s.setCaptureCounter(7);

  s.disconnect('sock-1');
  s.advance(31_000);
  const reaped = s.reap();

  assert.equal(reaped.sessionReset, true);
  assert.equal(s.conductorDeviceId, null);
  assert.equal(s.syncStarted, false);
  assert.equal(s.pin, null, 'next session mints a fresh PIN');
  assert.equal(s.captureCounter, 7, 'but S3 folder numbering keeps counting up');
});

// === commands ========================================================

test('capture is refused before sync has started', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });

  const res = s.triggerCapture(A);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NOT_SYNCED');
});

test('capture returns a sortable folder name and advances the counter', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.startSync(A);

  const first = s.triggerCapture(A);
  assert.equal(first.ok, true);
  assert.match(first.folderName, /^02_\d{8}_\d{6}_\d+$/);

  const second = s.triggerCapture(A);
  assert.match(second.folderName, /^03_/, 'counter increments per capture');
});

test('clients cannot trigger a capture', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.join({ deviceId: B, socketId: 'sock-2', pin: '4242' });
  s.startSync(A);

  const res = s.triggerCapture(B);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NOT_CONDUCTOR');
});

test('starting sync twice is reported, not silently ignored', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });

  assert.equal(s.startSync(A).ok, true);
  const again = s.startSync(A);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'ALREADY_SYNCED');
});

test('sync survives the conductor reconnecting mid-session', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.startSync(A);

  s.disconnect('sock-1');
  s.advance(4_000);
  const rejoin = s.join({ deviceId: A, socketId: 'sock-9', pin: '4242' });

  assert.equal(rejoin.syncStarted, true, 'the phone can resume recording on rejoin');
  assert.equal(s.triggerCapture(A).ok, true);
});

// === flash phone =====================================================

test('only the conductor can pick the flash phone', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.join({ deviceId: B, socketId: 'sock-2', pin: '4242', hasFlash: true });

  assert.equal(s.selectFlashPhone(B, B).error, 'NOT_CONDUCTOR');
  assert.equal(s.selectFlashPhone(A, B).ok, true);
  assert.equal(s.flashDeviceId, B);
});

test('selecting a disconnected phone as flash is refused', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });

  const res = s.selectFlashPhone(A, C);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'UNKNOWN_DEVICE');
});

test('flash selection is keyed to the device, so it survives a reconnect', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.join({ deviceId: B, socketId: 'sock-2', pin: '4242', hasFlash: true });
  s.selectFlashPhone(A, B);

  s.disconnect('sock-2');
  s.advance(2_000);
  const rejoin = s.join({ deviceId: B, socketId: 'sock-2-NEW', pin: '4242', hasFlash: true });

  assert.equal(rejoin.isFlashPhone, true);
  assert.equal(s.flashDeviceId, B);
});

// === upload authorization ============================================

test('presigned uploads require a valid PIN and a known device', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });

  assert.equal(s.authorizeUpload({ deviceId: A, pin: '4242' }).ok, true);
  assert.equal(s.authorizeUpload({ deviceId: A, pin: '9999' }).error, 'BAD_PIN');
  assert.equal(s.authorizeUpload({ deviceId: C, pin: '4242' }).error, 'UNKNOWN_DEVICE');
});

test('uploads are refused when no session is active', () => {
  const s = makeSession();
  const res = s.authorizeUpload({ deviceId: A, pin: '4242' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NO_SESSION');
});

test('an idle server does not churn out a new session on every reap tick', () => {
  const s = makeSession();
  s.join({ deviceId: A, socketId: 'sock-1' });
  s.disconnect('sock-1');
  s.advance(31_000);

  const first = s.reap();
  assert.equal(first.sessionReset, true, 'the emptied session is reset once');
  const freshId = s.sessionId;

  s.advance(31_000);
  const second = s.reap();
  assert.equal(second.sessionReset, false, 'nothing left to reset');
  assert.equal(s.sessionId, freshId, 'sessionId and PIN must not churn while idle');
});
