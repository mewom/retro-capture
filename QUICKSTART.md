# Quick Start Guide (For Non-Coders)

## What You'll Need
- A computer (Mac or Windows)
- WiFi network
- Up to 100 phones (all on the same WiFi)
- Amazon AWS account (for cloud storage)

---

## Super Simple Setup (5 Steps)

### 1️⃣ Install Node.js
Go to https://nodejs.org/ and download the installer. Run it.

### 2️⃣ Install Project Files
Open Terminal and type these commands (one at a time):
```bash
cd ~/Desktop/retro-capture
npm install
```
Wait for it to finish (1-2 minutes).

### 3️⃣ Set Up AWS S3
1. Go to https://aws.amazon.com/s3/
2. Create a new bucket (give it any name)
3. Get your access keys from AWS Console → Security credentials
4. Copy `.env.example` to `.env` and fill in your AWS details

### 4️⃣ Start the Server
In Terminal:
```bash
npm start
```

### 5️⃣ Connect Phones
Find your computer's IP address (see README.md for how).
On each phone, open browser and go to: `http://YOUR_IP:3000`

**That's it! The first phone is the master. They press the red button to capture.**

---

## How to Use

1. **First phone** to connect = MASTER (sees red button)
2. **Other phones** = CLIENTS (just wait)
3. **When ready**, master presses **CAPTURE**
4. **All phones** save last 5 seconds and upload
5. **Videos are in S3** in the `videos/` folder

---

## What Happens Behind the Scenes

Think of it like taking a group photo, but for video:

- **Your computer** = The photographer saying "Say cheese!"
- **Master phone** = The person who tells everyone when to smile
- **Client phones** = Everyone else waiting for the signal
- **5-second buffer** = Like rewinding time 5 seconds
- **Beep sound** = Like a flash, but for syncing videos later
- **S3 upload** = Like auto-saving to the cloud

---

## One-Line Summary

**All phones record continuously, master presses button, everyone saves last 5 seconds, synced by audio beep.**
