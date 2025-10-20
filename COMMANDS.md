# Quick Commands Reference

## 🚀 To Push to GitHub (After Creating Repo)

**First, create the repo on GitHub:** https://github.com/new

Then run these commands **one at a time**:

```bash
# 1. Go to project folder
cd ~/Desktop/retro-capture

# 2. Add all files
git add .

# 3. Make first commit
git commit -m "Initial commit - Retro Capture system"

# 4. Connect to GitHub (REPLACE YOUR_USERNAME with your actual GitHub username!)
git remote add origin https://github.com/YOUR_USERNAME/retro-capture.git

# 5. Push to GitHub
git branch -M main
git push -u origin main
```

---

## 🔄 To Update After Making Changes

```bash
cd ~/Desktop/retro-capture
git add .
git commit -m "Describe what you changed"
git push
```

Render will automatically redeploy!

---

## 🧪 To Test Locally (Before Deploying)

```bash
cd ~/Desktop/retro-capture
npm start
```

Then open: `http://localhost:3000`

Press `Ctrl+C` to stop the server.

---

## 📝 To Check Git Status

```bash
cd ~/Desktop/retro-capture
git status
```

Shows what files have changed.

---

## 🔍 To View Git History

```bash
cd ~/Desktop/retro-capture
git log --oneline
```

Shows all your commits.

---

## ❌ To Remove Git Remote (If You Made a Mistake)

```bash
cd ~/Desktop/retro-capture
git remote remove origin
```

Then you can add the correct one again.

---

## 📦 To Reinstall Packages (If Something Breaks)

```bash
cd ~/Desktop/retro-capture
rm -rf node_modules package-lock.json
npm install
```

---

## 🆘 To Start Fresh with Git

```bash
cd ~/Desktop/retro-capture
rm -rf .git
git init
```

Then follow the GitHub push commands again.
