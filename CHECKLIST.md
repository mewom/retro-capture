# Setup Checklist

Use this checklist to make sure everything is ready to go!

## ✅ Pre-Flight Checklist

### Computer Setup
- [ ] Node.js installed (v16 or higher)
- [ ] Project files downloaded/extracted
- [ ] Terminal open and working

### Network Setup
- [ ] Computer connected to WiFi
- [ ] WiFi network is reliable (not public WiFi with restrictions)
- [ ] You know your computer's IP address (e.g., 192.168.1.123)
- [ ] Firewall allows connections on port 3000 (or is turned off temporarily)

### AWS Setup
- [ ] AWS account created
- [ ] S3 bucket created
- [ ] Bucket name saved somewhere
- [ ] Access Key ID obtained
- [ ] Secret Access Key obtained (and saved securely!)
- [ ] Region selected (e.g., us-east-1)

### Project Configuration
- [ ] Ran `npm install` successfully (no errors)
- [ ] Created `.env` file (copied from `.env.example`)
- [ ] Filled in all AWS credentials in `.env`
- [ ] Bucket name matches what's in AWS
- [ ] Server starts without errors (`npm start`)

### Phone Setup
- [ ] All phones on the same WiFi as computer
- [ ] Phones are charged (or charging)
- [ ] Cameras work
- [ ] Browsers are modern (not ancient Internet Explorer!)

---

## 🎬 Pre-Capture Checklist

Before you actually capture:

- [ ] Server is running (`npm start` completed successfully)
- [ ] At least 2 phones connected (to test)
- [ ] First phone shows "👑 MASTER"
- [ ] Other phones show "📱 CLIENT"
- [ ] All phones granted camera/microphone permissions
- [ ] All phones show video preview
- [ ] All phones show "Recording buffer active" status
- [ ] Connection count is correct
- [ ] Master can see the red CAPTURE button

---

## 🧪 Test Capture

Do a test with 2-3 phones first:

1. [ ] Position phones
2. [ ] Wait 5 seconds for buffer to fill
3. [ ] Master presses CAPTURE
4. [ ] All phones play beep sound
5. [ ] All phones show "Saving video..."
6. [ ] All phones show "Upload successful"
7. [ ] Check S3 bucket - videos are there
8. [ ] Download one video and verify it plays
9. [ ] Check that video is ~5 seconds long

---

## 🔍 Troubleshooting Quick Checks

If something goes wrong:

**Server won't start**
- [ ] Check Terminal for error messages
- [ ] Verify Node.js is installed: `node --version`
- [ ] Re-run `npm install`
- [ ] Check if port 3000 is already in use

**Phones can't connect**
- [ ] Verify IP address is correct
- [ ] Phones and computer on SAME WiFi?
- [ ] Try turning off computer firewall temporarily
- [ ] Server is actually running?
- [ ] Try adding `:3000` to the URL

**Camera not working**
- [ ] Refresh the page
- [ ] Check browser permissions (Settings → Safari/Chrome)
- [ ] Try a different browser
- [ ] Restart the phone if needed

**Upload failing**
- [ ] Check AWS credentials in `.env`
- [ ] Verify S3 bucket exists
- [ ] Check bucket permissions (should allow uploads)
- [ ] Look at server Terminal for detailed error

**Videos out of sync**
- [ ] Look for the beep in audio waveform
- [ ] Use metadata JSON files for exact timestamps
- [ ] Make sure all phones captured at same moment

---

## 📊 Production Checklist (100 phones)

If you're going big:

**Before the shoot:**
- [ ] Test with 5-10 phones first
- [ ] Verify upload speed can handle it (may take 5-10 min for all uploads)
- [ ] Have backup plan if server crashes
- [ ] Know how to restart server quickly
- [ ] Have someone monitoring the server Terminal
- [ ] Phones are labeled/numbered (for identifying footage later)

**During the shoot:**
- [ ] Assign helpers to connect phones
- [ ] Give master phone to director/person in charge
- [ ] Verify all phones connected before first capture
- [ ] Watch Terminal for upload progress
- [ ] Don't restart server while uploads happening!

**After the shoot:**
- [ ] Verify all videos in S3
- [ ] Download metadata files
- [ ] Keep server running until all uploads complete
- [ ] Back up S3 bucket to another location
- [ ] Thank your phone-holders!

---

## ✨ You're Ready!

Once all checkmarks are done, you're ready to capture!

Remember: The first phone to connect is the master. Make sure that's the person you want controlling the captures!

Good luck! 🎥
