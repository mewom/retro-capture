// This is the SERVER - the brain that coordinates all phones
// It can run on your computer OR in the cloud (Render, AWS, etc.)

require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { SessionState, DEVICE_ID_PATTERN } = require('./lib/session');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '1mb' })); // videos no longer pass through here
app.use(express.static('public'));

// --- AWS S3 ----------------------------------------------------------

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'retro-capture-videos';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// Storage mode: S3 when credentials are present, otherwise local disk.
// The local mode exists so the whole sync flow can be exercised without an AWS
// account. It is for testing only - see the warning logged at startup.
const hasS3Credentials = Boolean(
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
);
const STORAGE_MODE =
  (process.env.STORAGE_MODE || (hasS3Credentials ? 's3' : 'local')).toLowerCase();
const LOCAL_UPLOAD_DIR = path.resolve(
  process.env.LOCAL_UPLOAD_DIR || path.join(__dirname, 'uploads')
);

const s3Client =
  STORAGE_MODE === 's3'
    ? new S3Client({
        region: AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      })
    : null;

// Short-lived tokens that stand in for presigned URLs in local mode.
const localUploadTokens = new Map();
const LOCAL_TOKEN_TTL_MS = UPLOAD_URL_TTL_SECONDS * 1000;

function issueLocalUploadToken(key, contentType, size) {
  const token = crypto.randomBytes(24).toString('hex');
  localUploadTokens.set(token, {
    key,
    contentType,
    size,
    expiresAt: Date.now() + LOCAL_TOKEN_TTL_MS
  });
  return token;
}

function consumeLocalUploadToken(token) {
  const entry = localUploadTokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    localUploadTokens.delete(token);
    return null;
  }
  localUploadTokens.delete(token);
  return entry;
}

// --- session ---------------------------------------------------------

const CONDUCTOR_GRACE_MS = Number(process.env.CONDUCTOR_GRACE_MS || 30000);
const configuredPin = (process.env.SESSION_PIN || '').trim();
if (configuredPin && !/^\d{4}$/.test(configuredPin)) {
  console.error('❌ SESSION_PIN must be exactly 4 digits. Ignoring it.');
}

const session = new SessionState({
  conductorGraceMs: CONDUCTOR_GRACE_MS,
  fixedPin: /^\d{4}$/.test(configuredPin) ? configuredPin : null
});

console.log('🎥 Retro Capture Server Starting...');
if (STORAGE_MODE === 's3') {
  console.log(`📦 Storage: AWS S3 bucket "${S3_BUCKET_NAME}"`);
} else {
  console.log(`📦 Storage: LOCAL DISK at ${LOCAL_UPLOAD_DIR}`);
  console.log(
    hasS3Credentials
      ? '⚠️  STORAGE_MODE=local is set, so S3 is being bypassed.'
      : '⚠️  No AWS credentials found - running in local storage mode.'
  );
  console.log('⚠️  On Render this disk is EPHEMERAL: clips are lost on redeploy.');
  console.log('⚠️  Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY to use S3.');
}
console.log(`⏳ Conductor reconnect grace: ${CONDUCTOR_GRACE_MS}ms`);
console.log(
  configuredPin
    ? '🔐 Using SESSION_PIN from the environment'
    : '🔐 PIN is generated per session and shown on the conductor phone'
);

// Folder numbering picks up where S3 left off.
async function initializeCaptureCounter() {
  if (STORAGE_MODE !== 's3') {
    try {
      const entries = await fsp.readdir(path.join(LOCAL_UPLOAD_DIR, 'captures'));
      const counters = entries
        .map((name) => {
          const match = name.match(/^(\d{2})_/);
          return match ? parseInt(match[1], 10) : -1;
        })
        .filter((n) => n >= 0);
      if (counters.length > 0) session.setCaptureCounter(Math.max(...counters) + 1);
      console.log(`📊 Local captures found: ${counters.length}`);
    } catch (error) {
      console.log('📊 No local captures yet, starting counter at 02');
    }
    return;
  }

  try {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET_NAME,
        Prefix: 'captures/',
        Delimiter: '/'
      })
    );

    const counters = (response.CommonPrefixes || [])
      .map((prefix) => {
        const folderName = prefix.Prefix.replace('captures/', '').replace('/', '');
        const match = folderName.match(/^(\d{2})_/);
        return match ? parseInt(match[1], 10) : -1;
      })
      .filter((num) => num >= 0);

    if (counters.length > 0) {
      session.setCaptureCounter(Math.max(...counters) + 1);
      console.log(
        `📊 Found ${counters.length} existing captures, starting counter at ` +
          String(session.captureCounter).padStart(2, '0')
      );
    } else {
      console.log('📊 No existing captures found, starting counter at 02');
    }
  } catch (error) {
    console.error('⚠️ Could not initialize counter from S3:', error.message);
    console.log('📊 Using default counter start: 02');
  }
}

// Deliberately NOT called at import time: requiring this module (as the tests
// do) must not reach out to the network. It runs from the startup path below.

// --- broadcast helpers ------------------------------------------------

function broadcastStatus() {
  io.emit('status', {
    totalClients: session.onlineCount(),
    sessionId: session.sessionId,
    syncStarted: session.syncStarted
  });
}

function sendFlashPhonesList() {
  const conductorSocket = session.conductorSocketId();
  if (!conductorSocket) return;
  io.to(conductorSocket).emit('flash-phones-list', {
    phones: session.flashCapableDevices()
  });
}

function broadcastFlashAssignment() {
  for (const device of session.onlineDevices()) {
    io.to(device.socketId).emit('set-flash-phone', {
      isFlashPhone: device.deviceId === session.flashDeviceId
    });
  }
}

function sendRole(device) {
  if (!device || !device.socketId) return;
  io.to(device.socketId).emit('role', {
    role: session.roleOf(device.deviceId),
    deviceId: device.deviceId,
    sessionId: session.sessionId,
    syncStarted: session.syncStarted
  });
}

// Reap stale devices and promote a new conductor if the old one never returned.
setInterval(() => {
  const { removed, promoted, sessionReset } = session.reap();

  if (removed.length > 0) {
    console.log(`🧹 Removed ${removed.length} device(s) after the grace window`);
  }
  if (promoted) {
    console.log(`🎵 New conductor promoted: ${promoted}`);
    sendRole(session.getDevice(promoted));
    sendFlashPhonesList();
  }
  if (sessionReset) {
    console.log('🔄 Session reset - no phones connected');
  }
  if (removed.length > 0 || promoted) {
    broadcastStatus();
  }
}, 5000);

// --- socket wiring ----------------------------------------------------

// Every handler answers through `ack` so the phone can show a real reason
// instead of a button that appears to do nothing (the v1 failure mode).
function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
  return payload;
}

io.on('connection', (socket) => {
  console.log(`📱 Socket connected: ${socket.id}`);

  // A socket does nothing until it joins with a stable deviceId + PIN.
  socket.on('join', (data, ack) => {
    const payload = data || {};
    const result = session.join({
      deviceId: payload.deviceId,
      pin: payload.pin,
      hasFlash: payload.hasFlash,
      socketId: socket.id
    });

    if (!result.ok) {
      console.log(`🚫 Join refused for ${socket.id}: ${result.error}`);
      return reply(ack, result);
    }

    socket.data.deviceId = result.deviceId;

    // Close the phone's previous socket so we do not count ghosts.
    if (result.replacedSocketId) {
      const stale = io.sockets.sockets.get(result.replacedSocketId);
      if (stale) stale.disconnect(true);
      console.log(`♻️  ${result.deviceId} replaced socket ${result.replacedSocketId}`);
    }

    console.log(`✅ ${result.deviceId} joined as ${result.role} (${socket.id})`);

    reply(ack, result);
    broadcastStatus();
    sendFlashPhonesList();
    socket.emit('set-flash-phone', { isFlashPhone: result.isFlashPhone });
  });

  socket.on('register-flash', (data, ack) => {
    const deviceId = socket.data.deviceId;
    if (!deviceId) {
      return reply(ack, {
        ok: false,
        error: 'NOT_JOINED',
        message: 'Join the session first.'
      });
    }
    session.setFlashCapability(deviceId, (data || {}).hasFlash);
    sendFlashPhonesList();
    return reply(ack, { ok: true });
  });

  socket.on('select-flash-phone', (data, ack) => {
    const result = session.selectFlashPhone(
      socket.data.deviceId,
      (data || {}).deviceId
    );
    if (!result.ok) return reply(ack, result);

    console.log(`⚡ Flash phone set to: ${result.flashDeviceId || 'none'}`);
    broadcastFlashAssignment();
    sendFlashPhonesList();
    return reply(ack, result);
  });

  socket.on('start-sync', (_data, ack) => {
    const result = session.startSync(socket.data.deviceId);
    if (!result.ok) {
      console.log(
        `🚫 start-sync refused for ${socket.data.deviceId || socket.id}: ${result.error}`
      );
      return reply(ack, result);
    }

    console.log(`🎬 SYNC STARTED by ${socket.data.deviceId}`);
    console.log(`   Broadcasting countdown to ${result.totalClients} phones`);
    reply(ack, result);

    let countdown = 3;
    const countdownInterval = setInterval(() => {
      if (countdown > 0) {
        io.emit('sync-countdown', { count: countdown });
        countdown--;
      } else {
        clearInterval(countdownInterval);
        io.emit('sync-go');
        console.log('   🚀 GO! All phones should start NOW');
      }
    }, 1000);
  });

  socket.on('trigger-capture', (_data, ack) => {
    const result = session.triggerCapture(socket.data.deviceId);
    if (!result.ok) {
      console.log(
        `🚫 trigger-capture refused for ${socket.data.deviceId || socket.id}: ${result.error}`
      );
      return reply(ack, result);
    }

    console.log(`🔴 CAPTURE TRIGGERED — folder: ${result.folderName}`);
    reply(ack, result);

    io.emit('capture', {
      timestamp: result.timestamp,
      sessionId: result.sessionId,
      folderName: result.folderName
    });
  });

  socket.on('video-uploaded', (data) => {
    console.log(`✅ Upload confirmed by ${socket.data.deviceId}: ${(data || {}).filename}`);
  });

  socket.on('disconnect', (reason) => {
    const { deviceId, wasConductor, superseded } = session.disconnect(socket.id);
    if (!deviceId) return;

    if (superseded) {
      console.log(`📱 Stale socket closed for ${deviceId} (${reason})`);
      return;
    }

    console.log(`📱 ${deviceId} disconnected (${reason})`);
    if (wasConductor) {
      console.log(
        `   Holding the conductor seat for ${CONDUCTOR_GRACE_MS}ms in case it reconnects`
      );
    }
    broadcastStatus();
    sendFlashPhonesList();
  });
});

// --- presigned upload -------------------------------------------------

// Phones upload straight to S3. The server only signs the request, so a 100MB
// clip never occupies a Render dyno's memory (v1 buffered it all with multer).
app.post('/api/upload-url', async (req, res) => {
  const { deviceId, pin, folderName, filename, contentType, size } = req.body || {};

  const auth = session.authorizeUpload({ deviceId, pin });
  if (!auth.ok) return res.status(403).json(auth);

  if (!DEVICE_ID_PATTERN.test(String(deviceId || ''))) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DEVICE_ID',
      message: 'Malformed device ID.'
    });
  }
  // Keys are built from client input, so both parts must be inert: no slashes,
  // no dots, nothing that could escape the captures/ prefix.
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(folderName || ''))) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_FOLDER',
      message: 'Malformed folder name.'
    });
  }
  if (!/^[A-Za-z0-9_-]{1,160}\.webm$/.test(String(filename || ''))) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_FILENAME',
      message: 'Malformed filename.'
    });
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      ok: false,
      error: 'TOO_LARGE',
      message: `Video must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes.`
    });
  }

  const videoType =
    typeof contentType === 'string' && contentType.startsWith('video/')
      ? contentType
      : 'video/webm';

  const videoKey = `captures/${folderName}/${filename}`;
  const metadataKey = `${videoKey}.json`;

  // Local mode: hand back URLs on this server instead of S3 ones. The phone's
  // upload code does not change - it just PUTs to whatever URL it is given.
  if (STORAGE_MODE !== 's3') {
    const videoToken = issueLocalUploadToken(videoKey, videoType, size);
    const metadataToken = issueLocalUploadToken(metadataKey, 'application/json', null);
    const base = `${req.protocol}://${req.get('host')}`;
    console.log(`🔗 Local upload token for ${videoKey} (${size} bytes)`);
    return res.json({
      ok: true,
      storage: 'local',
      videoUrl: `${base}/api/local-upload/${videoToken}`,
      metadataUrl: `${base}/api/local-upload/${metadataToken}`,
      videoKey,
      metadataKey,
      contentType: videoType,
      expiresIn: UPLOAD_URL_TTL_SECONDS
    });
  }

  try {
    const [videoUrl, metadataUrl] = await Promise.all([
      getSignedUrl(
        s3Client,
        new PutObjectCommand({
          Bucket: S3_BUCKET_NAME,
          Key: videoKey,
          ContentType: videoType
        }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS }
      ),
      getSignedUrl(
        s3Client,
        new PutObjectCommand({
          Bucket: S3_BUCKET_NAME,
          Key: metadataKey,
          ContentType: 'application/json'
        }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS }
      )
    ]);

    console.log(`🔗 Signed upload URL for ${videoKey} (${size} bytes)`);
    res.json({
      ok: true,
      storage: 's3',
      videoUrl,
      metadataUrl,
      videoKey,
      metadataKey,
      contentType: videoType,
      expiresIn: UPLOAD_URL_TTL_SECONDS
    });
  } catch (error) {
    console.error('❌ Could not sign upload URL:', error);
    res.status(500).json({
      ok: false,
      error: 'SIGN_FAILED',
      message: error.message
    });
  }
});

// Receives the body of a local-mode upload. The token is single-use and
// carries the destination key, so the request body can never pick its own path.
app.put(
  '/api/local-upload/:token',
  express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    if (STORAGE_MODE === 's3') {
      return res.status(404).json({ ok: false, error: 'NOT_LOCAL_MODE' });
    }

    const entry = consumeLocalUploadToken(req.params.token);
    if (!entry) {
      return res.status(403).json({
        ok: false,
        error: 'BAD_TOKEN',
        message: 'Upload link is invalid or expired.'
      });
    }

    const destination = path.resolve(LOCAL_UPLOAD_DIR, entry.key);
    // Belt and braces: the key came from our own validated inputs, but never
    // let a write escape the upload directory.
    if (
      destination !== LOCAL_UPLOAD_DIR &&
      !destination.startsWith(LOCAL_UPLOAD_DIR + path.sep)
    ) {
      return res.status(400).json({ ok: false, error: 'INVALID_KEY' });
    }

    try {
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, req.body);
      const bytes = req.body ? req.body.length : 0;
      console.log(`💾 Saved locally: ${entry.key} (${bytes} bytes)`);
      res.json({ ok: true, key: entry.key, size: bytes });
    } catch (error) {
      console.error('❌ Local write failed:', error);
      res.status(500).json({ ok: false, error: 'WRITE_FAILED', message: error.message });
    }
  }
);

// Browse what has been captured in local mode.
if (STORAGE_MODE !== 's3') {
  fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  app.use('/captures', express.static(LOCAL_UPLOAD_DIR));
}

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    storage: STORAGE_MODE,
    sessionId: session.sessionId,
    totalClients: session.onlineCount(),
    syncStarted: session.syncStarted,
    hasConductor: session.conductorDeviceId !== null
  });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  initializeCaptureCounter();
  server.listen(PORT, () => {
    console.log('✅ Server is running!');
    console.log(`🌐 Open this on your phones: http://YOUR_COMPUTER_IP:${PORT}`);
    console.log('');
    console.log('📋 Instructions:');
    console.log('   1. First phone to connect becomes the CONDUCTOR');
    console.log('   2. It is shown a 4-digit PIN; other phones enter it to join');
    console.log('   3. Conductor presses START SYNC, then CAPTURE');
    console.log(
      STORAGE_MODE === 's3'
        ? '   4. Phones upload straight to S3 via presigned URLs'
        : `   4. Clips are saved to ${LOCAL_UPLOAD_DIR} (testing only)`
    );
  });
}

module.exports = { app, server, io, session };
