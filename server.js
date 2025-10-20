// This is the SERVER - the brain that coordinates all phones
// It can run on your computer OR in the cloud (Render, AWS, etc.)

// Load environment variables from .env file (for local development)
require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

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

// Cloudflare R2 Configuration
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'retro-capture-videos';

// Keep track of connected phones
let masterClient = null; // The first phone that connects (the boss)
let clients = new Map(); // All connected phones
let sessionId = Date.now(); // Unique ID for this capture session

console.log('🎥 Retro Capture Server Starting...');
console.log(`📦 R2 Bucket: ${R2_BUCKET_NAME}`);

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
    connected: new Date()
  });

  // Tell all phones how many are connected
  io.emit('status', {
    totalClients: clients.size,
    sessionId
  });

  // When the master presses the capture button
  socket.on('trigger-capture', () => {
    if (socket.id === masterClient) {
      const captureTime = Date.now();
      console.log(`🔴 CAPTURE TRIGGERED at ${new Date(captureTime).toISOString()}`);
      console.log(`   Broadcasting to ${clients.size} phones`);

      // Tell ALL phones to save their last 5 seconds RIGHT NOW
      io.emit('capture', {
        timestamp: captureTime,
        sessionId
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

// Upload endpoint - receives videos from phones and uploads to Cloudflare R2
app.post('/upload', async (req, res) => {
  try {
    const { videoData, metadata } = req.body;

    console.log(`📤 Uploading ${metadata.filename} to Cloudflare R2...`);

    // Convert base64 back to binary
    const base64Data = videoData.replace(/^data:video\/webm;base64,/, '');
    const videoBuffer = Buffer.from(base64Data, 'base64');

    // Upload video to Cloudflare R2 using their API
    const videoKey = `videos/${metadata.sessionId}/${metadata.filename}`;
    const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/objects/${videoKey}`;

    const videoResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'video/webm'
      },
      body: videoBuffer
    });

    if (!videoResponse.ok) {
      throw new Error(`R2 upload failed: ${videoResponse.status} ${await videoResponse.text()}`);
    }

    console.log(`✅ Video uploaded: ${metadata.filename}`);

    // Upload metadata as JSON
    const metadataKey = `videos/${metadata.sessionId}/${metadata.filename}.json`;
    const metadataUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/objects/${metadataKey}`;

    const metadataResponse = await fetch(metadataUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metadata, null, 2)
    });

    if (!metadataResponse.ok) {
      throw new Error(`Metadata upload failed: ${metadataResponse.status} ${await metadataResponse.text()}`);
    }

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
  console.log('   4. Videos automatically upload to Cloudflare R2');
});
