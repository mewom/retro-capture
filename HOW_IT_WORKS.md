# How the Retro Capture System Works

## Visual Diagram

```
┌─────────────────────────────────────────────────────┐
│                  YOUR COMPUTER                       │
│  ┌───────────────────────────────────────────────┐  │
│  │         SERVER (Traffic Controller)           │  │
│  │  • Assigns master/client roles                │  │
│  │  • Broadcasts capture signal                  │  │
│  │  • Uploads videos to S3                       │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                        │
                        │ WiFi Connection
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   PHONE 1    │  │   PHONE 2    │  │   PHONE 3    │
│   (MASTER)   │  │   (CLIENT)   │  │   (CLIENT)   │
│              │  │              │  │              │
│  ┌────────┐  │  │  ┌────────┐  │  │  ┌────────┐  │
│  │ CAMERA │  │  │  │ CAMERA │  │  │  │ CAMERA │  │
│  └────────┘  │  │  └────────┘  │  │  └────────┘  │
│              │  │              │  │              │
│  5 SEC BUFFER│  │  5 SEC BUFFER│  │  5 SEC BUFFER│
│  ████████░░░░│  │  ████████░░░░│  │  ████████░░░░│
│              │  │              │  │              │
│  [CAPTURE]   │  │   waiting    │  │   waiting    │
│    BUTTON    │  │              │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

---

## Step-by-Step: What Happens

### Before Capture (Continuous Recording)

```
Phone 1, 2, 3: Recording continuously...

BUFFER (5 seconds, constantly updating):
[━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━]
 5s  4s  3s  2s  1s  NOW

As time passes, old video is thrown away:
Old ──→ ✗
New ──→ Kept
```

**What's happening:**
- Each phone records video non-stop
- Videos are split into 1-second chunks
- Only the last 5 chunks are kept
- Older chunks are deleted automatically

---

### The Capture Moment

```
1. Master presses CAPTURE button
   │
   ├─→ Server gets signal
   │
   ├─→ Server broadcasts to ALL phones: "CAPTURE NOW!"
   │   with exact timestamp: 1698765432123
   │
   └─→ All phones receive signal simultaneously
       │
       ├─→ Phone 1: BEEP! 🔊 Save buffer
       ├─→ Phone 2: BEEP! 🔊 Save buffer
       └─→ Phone 3: BEEP! 🔊 Save buffer
```

**What's happening:**
1. Master phone tells the server "capture now"
2. Server sends message to ALL phones at the exact same time
3. Each phone plays a beep sound (for syncing later)
4. Each phone saves its 5-second buffer
5. Videos start uploading to S3

---

### After Capture (Upload)

```
Phone 1 ──→ [Video 1] ──→ │
                          │
Phone 2 ──→ [Video 2] ──→ ├──→ Your Computer ──→ Amazon S3
                          │
Phone 3 ──→ [Video 3] ──→ │

S3 Bucket Structure:
videos/
  └── 1698765432123/  (session timestamp)
      ├── capture_xxx_phone1_1698765432123.webm
      ├── capture_xxx_phone1_1698765432123.webm.json
      ├── capture_xxx_phone2_1698765432123.webm
      ├── capture_xxx_phone2_1698765432123.webm.json
      ├── capture_xxx_phone3_1698765432123.webm
      └── capture_xxx_phone3_1698765432123.webm.json
```

**What's happening:**
- Each phone converts its buffer to a video file
- Videos are sent to your computer
- Your computer uploads them to Amazon S3
- Each video gets a metadata file with timing info

---

## The Sync System (How You'll Align Videos Later)

```
Video Editor Timeline View:

Track 1: ────────────▲beep─────────
Track 2: ────────────▲beep─────────
Track 3: ────────────▲beep─────────
                     │
                     └─ All beeps aligned = Perfect sync!
```

**Why the beep?**
- The beep happens at the exact moment of capture
- You can see it in the audio waveform
- Align all the beeps = all videos perfectly synchronized
- Works in any video editor (Premiere, Final Cut, DaVinci Resolve, etc.)

---

## File Formats Explained

### Video File (.webm)
- This is the actual video
- WebM format (works on all phones)
- Contains video + audio (including the sync beep)
- About 2-5 MB per 5 seconds

### Metadata File (.json)
- Text file with info about the video
- Contains exact timestamps
- Shows which phone recorded it
- Useful for advanced syncing

Example metadata:
```json
{
  "filename": "capture_1698765432123_abc123_1698765432123.webm",
  "sessionId": "1698765432123",
  "deviceId": "abc123",
  "captureTimestamp": 1698765432123,
  "role": "master",
  "duration": 5000
}
```

---

## Why This System is Clever

### Traditional video sync:
❌ Countdown → everyone starts recording → hope phones are synced
❌ Problems: phones have different lag, different start times
❌ Hard to sync in post

### Retro Capture system:
✅ Everyone already recording → save the PAST → exact timestamp
✅ No lag issues (already recording)
✅ Audio beep for easy alignment
✅ Metadata for precise frame-accurate sync

---

## The Master/Client System

### Why have a master?
- Only one person controls the capture
- Prevents accidental triggers
- Like a director calling "Action!"

### What if the master's phone dies?
- The next phone automatically becomes master
- No need to restart
- System keeps running

### Can the master change?
- Yes, if the current master disconnects
- The server automatically picks a new one
- Usually the next phone that connected

---

## Network Requirements

### Why same WiFi?
- Phones need to "see" your computer
- WiFi creates a local network (like walkie-talkies)
- Can't work over the internet (phones on different WiFi)

### What about phone network (4G/5G)?
- Possible but requires different setup (cloud server)
- More expensive (need to rent a server)
- Current version uses local WiFi (free!)

---

## Scaling to 100 Phones

The system can handle 100+ phones because:

1. **Lightweight messages** - Server just sends "capture now!" signal
2. **No video streaming** - Phones don't send video to each other
3. **Staggered uploads** - Videos upload one at a time (not all at once)
4. **Efficient buffer** - Only 5 seconds in memory (not hours)

**Bottleneck:** Upload speed to S3
- Solution: Each phone uploads independently
- Takes a few seconds per phone
- But capture is instant for all!

---

## Future: Gaussian Splats

(Not built yet, but here's the plan)

```
Multiple synced videos
        ↓
3D reconstruction software (COLMAP, RealityCapture)
        ↓
Point cloud
        ↓
Gaussian splatting (3D model)
        ↓
Interactive 3D scene!
```

You'll be able to create 3D scenes from your multi-phone captures!
