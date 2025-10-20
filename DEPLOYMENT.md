# Cloud Deployment Guide (GitHub + Render)

This guide will help you deploy your Retro Capture system to the cloud so it works from anywhere!

---

## 🎯 Why Deploy to the Cloud?

**Local (your computer):**
- ❌ Must keep computer running
- ❌ Phones must be on same WiFi
- ❌ Have to find your IP address every time
- ❌ Firewall issues

**Cloud (Render):**
- ✅ Always available
- ✅ Works from anywhere (phones on different networks)
- ✅ Easy URL like `https://retro-capture.onrender.com`
- ✅ Free tier available
- ✅ No firewall issues

---

## 📋 What You'll Need

1. ✅ GitHub account (you have this)
2. ✅ Render account (free - we'll create this)
3. ✅ AWS S3 account (for video storage)

**Total time:** 15-20 minutes

---

## Step 1: Push Code to GitHub

### 1.1 Create a New Repository on GitHub

1. Go to: https://github.com/new
2. Repository name: `retro-capture` (or whatever you like)
3. Description: "Multi-phone synchronized video capture system"
4. **Keep it PUBLIC** (easier for Render to access)
5. **DO NOT** check "Add README" or ".gitignore" (we already have these)
6. Click **"Create repository"**

### 1.2 Push Your Code

GitHub will show you some commands. **Ignore those** and run these instead:

Open Terminal and run these commands **one at a time**:

```bash
cd ~/Desktop/retro-capture

# Add all files to git
git add .

# Create your first commit
git commit -m "Initial commit - Retro Capture system"

# Connect to your GitHub repository
# REPLACE 'YOUR_USERNAME' with your actual GitHub username!
git remote add origin https://github.com/YOUR_USERNAME/retro-capture.git

# Push to GitHub
git branch -M main
git push -u origin main
```

**If it asks for credentials:**
- Username: Your GitHub username
- Password: Use a **Personal Access Token** (not your actual password)
  - Get one here: https://github.com/settings/tokens
  - Click "Generate new token (classic)"
  - Give it a name like "Retro Capture"
  - Check "repo" permissions
  - Generate and copy the token

✅ **Your code is now on GitHub!**

---

## Step 2: Set Up AWS S3

### 2.1 Create S3 Bucket

1. Go to: https://aws.amazon.com/s3/
2. Sign in (or create account)
3. Click **"Create bucket"**
4. Bucket name: `retro-capture-videos-2024` (must be globally unique)
5. Region: `us-east-1` (or your preferred region)
6. **Uncheck** "Block all public access" (we need to write to it)
7. Acknowledge the warning
8. Click **"Create bucket"**

### 2.2 Get AWS Credentials

1. Click your name (top right) → **"Security credentials"**
2. Scroll to **"Access keys"**
3. Click **"Create access key"**
4. Choose **"Application running outside AWS"**
5. Click **"Next"** → **"Create access key"**
6. **SAVE THESE SOMEWHERE SAFE:**
   - Access Key ID (like: `AKIAIOSFODNN7EXAMPLE`)
   - Secret Access Key (like: `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`)

⚠️ **You can only see the secret key once! Save it now!**

---

## Step 3: Deploy to Render

### 3.1 Create Render Account

1. Go to: https://render.com
2. Click **"Get Started"**
3. Sign up with GitHub (click "Sign up with GitHub")
4. Authorize Render to access your GitHub

### 3.2 Create New Web Service

1. On Render dashboard, click **"New +"** → **"Web Service"**
2. Click **"Connect a repository"**
3. Find your `retro-capture` repository and click **"Connect"**

### 3.3 Configure the Service

**Name:** `retro-capture` (or whatever you like)

**Region:** Choose closest to you

**Branch:** `main`

**Runtime:** `Node`

**Build Command:** `npm install`

**Start Command:** `npm start`

**Instance Type:** `Free` (or `Starter` for $7/month - better performance)

### 3.4 Add Environment Variables

Scroll down to **"Environment Variables"** and click **"Add Environment Variable"**

Add these **one at a time**:

| Key | Value |
|-----|-------|
| `AWS_ACCESS_KEY_ID` | Your AWS Access Key ID from Step 2.2 |
| `AWS_SECRET_ACCESS_KEY` | Your AWS Secret Access Key from Step 2.2 |
| `AWS_REGION` | `us-east-1` (or your region) |
| `S3_BUCKET_NAME` | Your bucket name from Step 2.1 |
| `NODE_ENV` | `production` |

### 3.5 Deploy!

1. Click **"Create Web Service"** at the bottom
2. Render will start building and deploying
3. Wait 2-5 minutes (watch the logs - it's cool!)
4. When you see **"Your service is live"** → IT'S DONE! 🎉

---

## Step 4: Get Your URL

1. On the Render dashboard, you'll see your service
2. The URL will be something like: `https://retro-capture.onrender.com`
3. Click it to test - you should see the camera interface!

✅ **Your app is now live on the internet!**

---

## Step 5: Use It!

### On Any Phone:

1. Open browser
2. Go to: `https://retro-capture.onrender.com` (your actual URL)
3. Allow camera/microphone access
4. First phone = Master
5. Other phones = Clients
6. Master presses capture!

**Phones can be:**
- On different WiFi networks
- In different cities
- On cellular data (4G/5G)
- Anywhere in the world!

---

## 📊 Free Tier Limits

Render Free tier:
- ✅ 750 hours/month (plenty!)
- ⚠️ Sleeps after 15 min of inactivity
- ⚠️ Takes ~30 seconds to wake up
- ⚠️ 512MB RAM (good for ~20-30 phones)

**For 100 phones:** Upgrade to Starter ($7/month) for 2GB RAM

---

## 🔄 Updating Your App

Made changes to the code? Easy!

```bash
cd ~/Desktop/retro-capture

# Make your changes, then:
git add .
git commit -m "Description of what you changed"
git push

# Render automatically redeploys! (takes 2-3 min)
```

---

## 🐛 Troubleshooting

### "Application failed to respond"
- Check the Render logs (click "Logs" tab)
- Verify environment variables are set
- Check S3 bucket name is correct

### Videos not uploading
- Verify AWS credentials in Render dashboard
- Check S3 bucket permissions (must allow writes)
- Look at Render logs for error messages

### App is slow
- Free tier sleeps - first request takes 30 sec
- Upgrade to Starter ($7/month) for always-on
- Or just wait 30 seconds for it to wake up

### "Cannot connect to server"
- Check URL is correct (https, not http)
- Phone has internet connection
- Render service is running (check dashboard)

---

## 💰 Cost Breakdown

**Free Option:**
- Render: Free
- AWS S3: ~$0.50-2/month (depends on usage)
- **Total: ~$1-2/month**

**Production Option (100 phones):**
- Render Starter: $7/month
- AWS S3: ~$5-10/month (lots of videos)
- **Total: ~$12-17/month**

---

## 🎉 You're Done!

Your retro capture system is now:
- ✅ Running in the cloud
- ✅ Accessible from anywhere
- ✅ Auto-deploying from GitHub
- ✅ Storing videos in S3
- ✅ Ready for 100 phones (on paid plan)

Share your URL with anyone and they can join the capture session!

---

## 📝 Your Info (Fill This In)

**GitHub Repository:** https://github.com/YOUR_USERNAME/retro-capture

**Render URL:** https://________________.onrender.com

**S3 Bucket:** ________________

**AWS Region:** ________________

---

## 🚀 Next Steps

- Test with 2-3 phones first
- Try a capture session
- Download videos from S3
- Sync them using the audio beep
- Scale up to more phones!

Enjoy! 🎥
