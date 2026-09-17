# Retro Capture v2 — What Changed

> **Note on provenance.** This file was regenerated in a cloud session that had
> a fresh clone of GitHub `main` and **no access to the `~/Desktop/retro-capture`
> folder on the Mac.** The earlier local v2 work (and its original
> `V2_CHANGES.md` / `retro-capture-review-and-roadmap.md`) was never pushed, so
> it could not be read or reused. The four fixes below were re-implemented from
> scratch against the stale `main`. If the local folder still holds the original
> v2 work, treat these two versions as alternatives — do not merge them
> together.

## The bug this release exists to fix

The **START SYNC** button would silently stop working.

`server.js` tracked the conductor by `socket.id`:

```js
let conductorClient = null;
conductorClient = socket.id;             // on first connection
if (socket.id === conductorClient) { … } // on start-sync — with no else
```

`socket.id` is regenerated on every reconnect. A screen lock, a WiFi blip, or
Safari backgrounding the tab produced a new `socket.id`, so the conductor phone
no longer matched `conductorClient`. The `start-sync` handler's `if` simply
evaluated false and **fell through with no else branch** — no error, no log to
the phone, no UI change. The button did nothing, forever.

The client made it worse:

```js
if (myRole !== null && myRole !== data.role) return; // "prevent role change"
```

The phone ignored the server's corrected role, so its UI kept claiming
CONDUCTOR while the server had moved on. The two disagreed permanently.

## The four changes

### 1. Stable `deviceId` identity (the actual fix)

- The phone generates a `deviceId` once and persists it in `localStorage`
  (`retro-capture:deviceId`).
- It is sent on every `join`, including automatic reconnects.
- The server keys everything — conductor, flash phone, client list — on
  `deviceId`, never on `socket.id`.
- The conductor seat is **held for a grace window** (`CONDUCTOR_GRACE_MS`,
  default 30s) after a disconnect. A phone that reconnects inside that window
  gets its role back. Only after the window expires is another phone promoted.
- A second connection from the same `deviceId` supersedes the first, and the
  stale socket's late `disconnect` can no longer demote the live one — this was
  the "ghost connection" class of bug.
- The client-side "ignore role changes" guard is gone; the server is now the
  single source of truth.

### 2. Ack-based errors instead of silent failure

Every command (`join`, `start-sync`, `trigger-capture`, `select-flash-phone`,
`register-flash`) takes a Socket.io acknowledgement callback and answers with
either `{ ok: true, … }` or `{ ok: false, error, message }`.

Error codes: `INVALID_DEVICE_ID`, `PIN_REQUIRED`, `BAD_PIN`, `NOT_JOINED`,
`NOT_CONDUCTOR`, `ALREADY_SYNCED`, `NO_DEVICES`, `NOT_SYNCED`,
`UNKNOWN_DEVICE`, `NO_SESSION`.

The phone shows `message` in a red banner across the top. The exact scenario
that used to fail silently now reads **"Only the conductor phone can start
sync."**

### 3. Four-digit session PIN

- The first phone to join becomes conductor and is shown a 4-digit PIN.
- Every other phone must enter that PIN to join.
- Clients are never told the PIN in a payload — they have to be shown it.
- Set `SESSION_PIN` to pin a fixed code; then *every* phone, including the
  conductor, must enter it.
- The PIN also guards the upload endpoint, so a public Render URL cannot be
  used by a stranger to mint storage credentials.

### 4. Direct-to-storage uploads (multer removed)

v1 POSTed the whole video to the Node server, which buffered it in memory via
`multer` and re-uploaded it to S3 — every clip crossed the network twice, and a
few phones capturing at once could exhaust a small Render instance.

Now `POST /api/upload-url` returns a presigned URL and the phone PUTs straight
to S3. The server only signs. `multer` is no longer a dependency.

Inputs to the signing endpoint are strictly validated (`folderName` and
`filename` are `[A-Za-z0-9_-]` only) so a request can never produce an S3 key
outside `captures/`.

## Bonus: local storage mode (no AWS account required)

Because the AWS account was inaccessible, the server now **falls back to local
disk when no AWS credentials are present**:

- `STORAGE_MODE` is `s3` when `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
  are set, otherwise `local`. Set it explicitly to override.
- In local mode `/api/upload-url` returns single-use tokenised URLs on this
  server; the phone's upload code is unchanged.
- Files land under `uploads/captures/<folder>/` and are browsable at
  `/captures/...`.
- `GET /healthz` reports the active mode.

> ⚠️ **Local mode is for testing.** Render's filesystem is ephemeral — clips are
> lost on every redeploy and on instance restarts. Move to S3 before relying on
> any capture.

## Required manual step — S3 bucket CORS

**Not yet done, and presigned uploads will fail without it.** Browsers block a
cross-origin `PUT` unless the bucket allows it. In the S3 console, under
**Permissions → Cross-origin resource sharing (CORS)**:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedOrigins": [
      "https://retro-capture.onrender.com",
      "http://localhost:3000"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Verify it (and the rest of the bucket) with:

```bash
npm run check:s3
```

That script lists the bucket, checks the CORS rules, performs a **real
presigned PUT** and deletes the probe object again. It is the only way to be
sure browser uploads will work.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | for S3 mode | S3 credentials |
| `AWS_SECRET_ACCESS_KEY` | for S3 mode | S3 credentials |
| `AWS_REGION` | no (default `us-east-1`) | Bucket region |
| `S3_BUCKET_NAME` | for S3 mode | Bucket name |
| `SESSION_PIN` | no | Fixed 4-digit PIN; otherwise generated per session |
| `CONDUCTOR_GRACE_MS` | no (default `30000`) | Conductor reconnect window |
| `STORAGE_MODE` | no (auto) | `s3` or `local` |
| `LOCAL_UPLOAD_DIR` | no (default `./uploads`) | Where local mode writes |

## Tests

```bash
npm test
```

28 checks: 23 unit tests over the state machine in `lib/session.js`, plus 6
integration tests that drive a real Socket.io server — including the exact
regression (conductor drops, reconnects on a new `socket.id`, and START SYNC
still works).

`--test-force-exit` is used because Socket.io leaves handles open after
teardown; every test completes and asserts before the runner exits.

## What is NOT covered by tests

The test suite verifies the **server and session logic**. It cannot verify
anything that needs real hardware:

- camera / microphone capture, `MediaRecorder` segment rotation
- the torch/flash trigger
- iOS Safari behaviour (backgrounding, autoplay, audio context)
- real multi-phone clock alignment

Those still need two or more real phones.
