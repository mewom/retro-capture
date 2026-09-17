'use strict';

// End-to-end check over a real Socket.io connection. The unit tests prove the
// state machine is correct; this proves the wiring around it is, too — which is
// exactly where the v1 bug lived (`socket.id` leaking into identity).

// Loopback must not go through an outbound HTTP proxy, or the client hangs.
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1,localhost']
  .filter(Boolean)
  .join(',');
process.env.no_proxy = process.env.NO_PROXY;

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

process.env.SESSION_PIN = '1234'; // deterministic PIN for the test run
process.env.STORAGE_MODE = 'local'; // exercise the no-AWS path deterministically
process.env.LOCAL_UPLOAD_DIR = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'retro-capture-test-')
);

const { server, session, io } = require('../server');

let baseUrl;

function connect() {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function join(socket, deviceId, pin = '1234', hasFlash = false) {
  return new Promise((resolve) => {
    socket.emit('join', { deviceId, pin, hasFlash }, resolve);
  });
}

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  // Closing the Socket.io server also drops every open socket and its ping
  // timers; closing only the HTTP server would leave the process hanging.
  await new Promise((resolve) => io.close(resolve));
});

test.beforeEach(() => {
  session.reset();
});

test('a phone must present the PIN to join', async () => {
  const socket = await connect();
  try {
    const refused = await join(socket, 'device-integration-1', '0000');
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'BAD_PIN');

    const accepted = await join(socket, 'device-integration-1', '1234');
    assert.equal(accepted.ok, true);
    assert.equal(accepted.role, 'conductor');
  } finally {
    socket.close();
  }
});

test('START SYNC from a client is refused with a readable message', async () => {
  const conductor = await connect();
  const client = await connect();
  try {
    await join(conductor, 'device-conductor-x');
    await join(client, 'device-client-x');

    const res = await emitAck(client, 'start-sync');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'NOT_CONDUCTOR');
    assert.match(res.message, /conductor/i);
  } finally {
    conductor.close();
    client.close();
  }
});

test('REGRESSION: conductor reconnects on a new socket and START SYNC still works', async () => {
  const conductor = await connect();
  const client = await connect();
  let revived;

  try {
    const first = await join(conductor, 'device-conductor-y');
    assert.equal(first.role, 'conductor');
    await join(client, 'device-client-y');

    const firstSocketId = conductor.id;

    // Simulate a screen lock: the socket drops entirely.
    conductor.close();
    await new Promise((r) => setTimeout(r, 150));

    // The phone comes back with a brand-new socket.id but the same deviceId.
    revived = await connect();
    assert.notEqual(revived.id, firstSocketId, 'socket.id really did change');

    const rejoin = await join(revived, 'device-conductor-y');
    assert.equal(rejoin.ok, true);
    assert.equal(rejoin.role, 'conductor', 'v1 demoted this phone to client here');

    // The button that used to silently do nothing:
    const sync = await emitAck(revived, 'start-sync');
    assert.equal(sync.ok, true);
  } finally {
    client.close();
    if (revived) revived.close();
  }
});

test('capture before sync is refused, and accepted after', async () => {
  const conductor = await connect();
  try {
    await join(conductor, 'device-conductor-z');

    const early = await emitAck(conductor, 'trigger-capture');
    assert.equal(early.error, 'NOT_SYNCED');

    await emitAck(conductor, 'start-sync');
    const ok = await emitAck(conductor, 'trigger-capture');
    assert.equal(ok.ok, true);
    assert.match(ok.folderName, /^\d{2}_\d{8}_\d{6}_\d+$/);
  } finally {
    conductor.close();
  }
});

test('the presigned upload endpoint rejects a bad PIN and path traversal', async () => {
  const conductor = await connect();
  try {
    await join(conductor, 'device-conductor-w');

    const badPin = await fetch(`${baseUrl}/api/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'device-conductor-w',
        pin: '9999',
        folderName: '02_20250101_000000_1',
        filename: 'clip.webm',
        size: 100
      })
    });
    assert.equal(badPin.status, 403);

    const traversal = await fetch(`${baseUrl}/api/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'device-conductor-w',
        pin: '1234',
        folderName: '../../etc',
        filename: 'passwd.webm',
        size: 100
      })
    });
    assert.equal(traversal.status, 400, 'must not sign a key outside captures/');
  } finally {
    conductor.close();
  }
});

test('local storage mode accepts a real upload end to end', async () => {
  // The suite runs without AWS credentials, so the server is in local mode.
  const conductor = await connect();
  try {
    await join(conductor, 'device-upload-test');
    const capture = await emitAck(conductor, 'start-sync').then(() =>
      emitAck(conductor, 'trigger-capture')
    );
    assert.equal(capture.ok, true);

    const sign = await fetch(`${baseUrl}/api/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'device-upload-test',
        pin: '1234',
        folderName: capture.folderName,
        filename: 'clip.webm',
        contentType: 'video/webm',
        size: 12
      })
    });
    assert.equal(sign.status, 200);
    const signed = await sign.json();
    assert.equal(signed.storage, 'local', 'no AWS creds => local mode');

    const put = await fetch(signed.videoUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
      body: Buffer.from('fake-webm-01')
    });
    assert.equal(put.status, 200);
    const result = await put.json();
    assert.equal(result.size, 12, 'the bytes actually landed on disk');

    // Upload tokens are single use.
    const replay = await fetch(signed.videoUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
      body: Buffer.from('fake-webm-01')
    });
    assert.equal(replay.status, 403, 'a used upload link must not work twice');
  } finally {
    conductor.close();
  }
});
