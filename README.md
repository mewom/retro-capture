# Retro Capture - Multi-Phone Video Sync System

This app lets you capture synchronized 5-second video clips from up to 100 phones at once!

## How It Works (Simple Explanation)

1. **You run a server** on your computer (like a traffic controller)
2. **Everyone opens a website** on their phones (connects to your computer)
3. **First person becomes the "master"** (they control when to capture)
4. **All phones record continuously** (keeping the last 5 seconds in memory)
5. **Master presses button** → everyone saves their last 5 seconds at the same time
6. **Videos upload to the cloud** (Amazon S3) automatically
7. **Sync in post** using the audio beep that plays during capture

---

## Setup Instructions

### Step 1: Install Node.js

You need Node.js to run the server. Think of it like installing Microsoft Word - it's the program that runs our code.

1. Go to: https://nodejs.org/
2. Download the "LTS" version (recommended)
3. Install it (just click next, next, next)
4. To check it worked, open Terminal and type:
   ```
   node --version
   ```
   You should see something like `v18.17.0`

---

### Step 2: Install the Project

1. Open Terminal
2. Navigate to the project folder:
   ```
   cd ~/Desktop/retro-capture
   ```
3. Install all the required tools (this downloads all the ingredients):
   ```
   npm install
   ```
   This will take 1-2 minutes. You'll see a lot of text - that's normal!

---

### Step 3: Set Up Amazon S3 (Cloud Storage)

You need a place to store all the videos. Amazon S3 is like Dropbox for apps.

#### Create an S3 Bucket:
1. Go to: https://aws.amazon.com/s3/
2. Sign up or log in
3. Click "Create bucket"
4. Give it a name like `my-retro-capture-videos` (must be unique worldwide)
5. Choose a region (like `us-east-1`)
6. Click "Create bucket"

#### Get Your Access Keys:
1. In AWS Console, click your name (top right) → Security credentials
2. Scroll to "Access keys"
3. Click "Create access key"
4. Save both the **Access Key ID** and **Secret Access Key** (you'll need these!)

#### Configure the App:
1. In the `retro-capture` folder, copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
2. Open `.env` in a text editor
3. Fill in your AWS credentials:
   ```
   AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
   AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
   AWS_REGION=us-east-1
   S3_BUCKET_NAME=my-retro-capture-videos
   ```

---

### Step 4: Start the Server

1. In Terminal, make sure you're in the project folder:
   ```
   cd ~/Desktop/retro-capture
   ```
2. Start the server:
   ```
   npm start
   ```
3. You should see:
   ```
   ✅ Server is running!
   🌐 Open this on your phones: http://YOUR_COMPUTER_IP:3000
   ```

---

### Step 5: Find Your Computer's IP Address

Phones need to know where to find your computer on the network.

**On Mac:**
1. Hold Option key, click WiFi icon (top right)
2. Look for "IP Address" - something like `192.168.1.123`

**On Windows:**
1. Open Command Prompt
2. Type `ipconfig`
3. Look for "IPv4 Address" - something like `192.168.1.123`

---

### Step 6: Connect Phones

**IMPORTANT:** All phones must be on the **same WiFi network** as your computer!

1. On each phone, open the web browser (Safari, Chrome, etc.)
2. Go to: `http://YOUR_COMPUTER_IP:3000`
   - Example: `http://192.168.1.123:3000`
3. Allow camera and microphone access when asked
4. First phone will show **"👑 MASTER"** with a red button
5. All other phones show **"📱 CLIENT"** - they just wait

---

## Using the App

1. **Position all phones** where you want them
2. **Wait until everyone is connected** (you'll see the count on each screen)
3. **Master phone:** When ready, press the big red **CAPTURE** button
4. **All phones will:**
   - Play a beep sound (for syncing later)
   - Save the last 5 seconds of video
   - Upload to S3 automatically
5. **Check S3** - videos will be in `videos/[session-id]/`

---

## Syncing Videos in Post-Production

Each video has a **1000Hz beep** that plays at the exact moment of capture.

To sync in your video editor:
1. Import all videos
2. Look at the audio waveforms
3. Find the beep spike in each video
4. Align all videos so the beeps line up
5. Now all videos are perfectly synchronized!

Alternatively, use the metadata JSON files - they contain exact timestamps.

---

## Troubleshooting

### "Cannot connect to server"
- Make sure your computer and phones are on the same WiFi
- Check your computer's firewall isn't blocking port 3000
- Make sure the server is running (`npm start`)

### "Camera access denied"
- Go to phone Settings → Safari (or Chrome) → Camera
- Enable camera access
- Refresh the page

### "Upload failed"
- Check your AWS credentials in `.env` file
- Make sure the S3 bucket name is correct
- Check your AWS account isn't over quota

### Server won't start
- Make sure you ran `npm install`
- Check Node.js is installed: `node --version`
- Make sure port 3000 isn't already in use

---

## Technical Details

**Buffer System:**
- Videos are recorded continuously in 1-second chunks
- Only the last 5 seconds are kept in memory
- When capture is triggered, those 5 seconds are saved
- Then recording continues normally

**Sync Mechanism:**
- Server broadcasts capture timestamp to all phones simultaneously
- Each phone plays a 1000Hz sine wave tone (0.5 seconds)
- Metadata includes exact timestamps for alignment

**File Naming:**
```
capture_[session-id]_[device-id]_[timestamp].webm
```

**S3 Structure:**
```
videos/
  └── 1698765432123/          (session ID)
      ├── capture_xxx_1.webm
      ├── capture_xxx_1.webm.json
      ├── capture_xxx_2.webm
      ├── capture_xxx_2.webm.json
      └── ...
```

---

## Future Enhancements (Not Yet Built)

- [ ] Gaussian splat generation pipeline
- [ ] Download and sync tool
- [ ] Preview mode (see what all phones see)
- [ ] Multiple capture sessions
- [ ] Export directly to video editing software

---

## Need Help?

If something isn't working, check the Terminal where the server is running - it shows helpful messages about what's happening!
