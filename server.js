// This is the SERVER - the brain that coordinates all phones
// It can run on your computer OR in the cloud (Render, AWS, etc.)

// Load environment variables from .env file (for local development)
require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const cors = require('cors');
const path = require('path');
const multer = require('multer');

// Configure multer for handling file uploads in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Create the web server
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*", // Allow any phone to connect
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 50e6 // Allow videos up to 50MB
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public')); // Serve the website files

// AWS S3 Configuration
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'retro-capture-videos';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Create S3 client
const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY
  }
});

// Keep track of connected phones
let masterClient = null; // The first phone that connects (the boss)
let clients = new Map(); // All connected phones
let sessionId = Date.now(); // Unique ID for this capture session
let captureCounter = 0; // Counter for sequential folder numbering

console.log('🎥 Retro Capture Server Starting...');
console.log(`📦 S3 Bucket: ${S3_BUCKET_NAME}`);

// When a phone connects
io.on('connection', (socket) => {
  console.log(`📱 New phone connected: ${socket.id}`);

  // If this is the first phone, make it the master
  if (!masterClient) {
    masterClient = socket.id;
    socket.emit('role', { role: 'master', sessionId });
    console.log(`👑 Master assigned: ${socket.id}`);
  } else {
    // Everyone else is a client
    socket.emit('role', { role: 'client', sessionId });
    console.log(`📱 Client assigned: ${socket.id}`);
  }

  // Add this phone to our list
  clients.set(socket.id, {
    id: socket.id,
    role: socket.id === masterClient ? 'master' : 'client',
    connected: new Date(),
    hasFlash: false // Will be updated when client registers
  });

  // Tell all phones how many are connected
  io.emit('status', {
    totalClients: clients.size,
    sessionId
  });

  // When a phone registers its flash capability
  socket.on('register-flash', (data) => {
    const client = clients.get(socket.id);
    if (client) {
      client.hasFlash = data.hasFlash;
      console.log(`📸 ${socket.id} flash capability: ${data.hasFlash}`);

      // Send updated flash-capable phones list to master
      if (masterClient) {
        const flashPhones = Array.from(clients.entries())
          .filter(([id, client]) => client.hasFlash)
          .map(([id, client]) => ({ id, role: client.role }));

        io.to(masterClient).emit('flash-phones-list', { phones: flashPhones });
        console.log(`📋 Sent flash phones list to master: ${flashPhones.length} phones`);
      }
    }
  });

  // When master selects a flash phone
  socket.on('select-flash-phone', (data) => {
    if (socket.id === masterClient) {
      const selectedId = data.phoneId;
      console.log(`⚡ Master selected flash phone: ${selectedId}`);

      // Tell all phones they are NOT the flash phone
      clients.forEach((client, id) => {
        io.to(id).emit('set-flash-phone', { isFlashPhone: false });
      });

      // Tell the selected phone it IS the flash phone
      if (selectedId && selectedId !== 'none') {
        io.to(selectedId).emit('set-flash-phone', { isFlashPhone: true });
      }
    }
  });

  // When the master presses the capture button
  socket.on('trigger-capture', () => {
    if (socket.id === masterClient) {
      const captureTime = Date.now();
      const captureDate = new Date(captureTime);

      // Create human-readable folder name with sequential counter
      // Format: XX_YYYYMMDD_HHMMSS_timestamp
      // Example: 00_20251020_152430_1729442670000
      const year = captureDate.getFullYear();
      const month = String(captureDate.getMonth() + 1).padStart(2, '0');
      const day = String(captureDate.getDate()).padStart(2, '0');
      const hours = String(captureDate.getHours()).padStart(2, '0');
      const minutes = String(captureDate.getMinutes()).padStart(2, '0');
      const seconds = String(captureDate.getSeconds()).padStart(2, '0');

      // Increment counter and pad to 2 digits (00, 01, 02, etc.)
      const counterStr = String(captureCounter).padStart(2, '0');
      captureCounter++;

      const folderName = `${counterStr}_${year}${month}${day}_${hours}${minutes}${seconds}_${captureTime}`;

      console.log(`🔴 CAPTURE TRIGGERED at ${captureDate.toLocaleString()}`);
      console.log(`   Folder: ${folderName} (capture #${captureCounter})`);
      console.log(`   Broadcasting to ${clients.size} phones`);

      // Tell ALL phones to save their last 6 seconds RIGHT NOW
      io.emit('capture', {
        timestamp: captureTime,
        sessionId,
        folderName: folderName
      });
    }
  });

  // When a phone uploads a video
  socket.on('video-uploaded', (data) => {
    console.log(`✅ Video received from ${socket.id}`);
    console.log(`   File: ${data.filename}`);
  });

  // When a phone disconnects
  socket.on('disconnect', () => {
    console.log(`📱 Phone disconnected: ${socket.id}`);
    clients.delete(socket.id);

    // If the master leaves, assign a new master
    if (socket.id === masterClient && clients.size > 0) {
      const newMaster = clients.keys().next().value;
      masterClient = newMaster;
      io.to(newMaster).emit('role', { role: 'master', sessionId });
      console.log(`👑 New master assigned: ${newMaster}`);
    } else if (clients.size === 0) {
      masterClient = null;
      sessionId = Date.now(); // New session for next connection
      console.log('🔄 Session reset - no phones connected');
    }

    // Update everyone on the count
    io.emit('status', {
      totalClients: clients.size,
      sessionId
    });
  });
});

// Upload endpoint - receives videos from phones and uploads to AWS S3
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    // Get the video file from multer (it's in memory as a Buffer)
    const videoBuffer = req.file.buffer;
    const metadata = JSON.parse(req.body.metadata);

    console.log(`📤 Uploading ${metadata.filename} to AWS S3...`);
    console.log(`   Size: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Upload video to S3 using folderName for organization
    const folderName = metadata.folderName || metadata.sessionId;
    const videoKey = `captures/${folderName}/${metadata.filename}`;
    const uploadCommand = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: videoKey,
      Body: videoBuffer,
      ContentType: 'video/webm'
    });

    await s3Client.send(uploadCommand);
    console.log(`✅ Video uploaded: ${folderName}/${metadata.filename}`);

    // Upload metadata as JSON
    const metadataKey = `captures/${folderName}/${metadata.filename}.json`;
    const metadataCommand = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: metadataKey,
      Body: JSON.stringify(metadata, null, 2),
      ContentType: 'application/json'
    });

    await s3Client.send(metadataCommand);
    console.log(`✅ Metadata uploaded: ${metadata.filename}.json`);

    res.json({
      success: true,
      message: 'Upload successful',
      filename: metadata.filename,
      size: videoBuffer.length
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('✅ Server is running!');
  console.log(`🌐 Open this on your phones: http://YOUR_COMPUTER_IP:${PORT}`);
  console.log('');
  console.log('📋 Instructions:');
  console.log('   1. First phone to connect becomes the MASTER');
  console.log('   2. All other phones are CLIENTS');
  console.log('   3. Master presses CAPTURE button to save last 5 seconds');
  console.log('   4. Videos automatically upload to AWS S3');
});
