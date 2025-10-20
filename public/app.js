// This is the BRAIN of the phone app
// It handles: camera access, continuous recording, and saving videos

// === CONFIGURATION ===
const BUFFER_DURATION = 6000; // Keep last 6 seconds (6000 milliseconds) - includes 1 sec for beep
const CHUNK_DURATION = 1000;  // Record in 1-second chunks
const SERVER_URL = window.location.origin; // Automatically use the server's address

// === GLOBAL VARIABLES ===
let socket;              // Connection to the server
let myRole = null;       // Am I 'master' or 'client'?
let sessionId = null;    // Unique ID for this capture session
let mediaRecorder;       // The thing that records video
let videoStream;         // The camera feed
let recordedChunks = []; // Stores the last 5 seconds of video
let audioContext;        // For playing the sync beep
let isUploading = false; // Are we currently uploading?

// === ELEMENTS (buttons, text, etc) ===
const videoPreview = document.getElementById('video-preview');
const roleDisplay = document.getElementById('role-display');
const statusText = document.getElementById('status-text');
const clientCount = document.getElementById('client-count');
const captureBtn = document.getElementById('capture-btn');
const messageDiv = document.getElementById('message');

// === STARTUP ===
console.log('📱 Retro Capture App Starting...');

// Show start button for Safari compatibility
showMessage('📱 TAP SCREEN TO START', null);
document.body.addEventListener('click', startApp, { once: true });
document.body.addEventListener('touchstart', startApp, { once: true });

async function startApp() {
    console.log('🎬 User tapped - starting app...');
    showMessage('⏳ Starting camera...', null);
    await init();
}

// Initialize everything
async function init() {
    try {
        // Step 1: Get camera and microphone access
        await startCamera();

        // Step 2: Start recording continuously
        await startContinuousRecording();

        // Step 3: Set up audio for sync beeps
        setupAudio();

        // Step 4: Connect to the server
        connectToServer();

        console.log('✅ App initialized successfully');

        // Hide the message after successful init
        setTimeout(() => {
            messageDiv.classList.remove('show');
        }, 2000);
    } catch (error) {
        console.error('❌ Initialization failed:', error);
        const errorMsg = error.message || error.toString();
        showMessage(`❌ CAMERA ERROR\n\n${errorMsg}\n\niPhone: Settings → Safari → Camera → Allow\n\nThen refresh this page.`, null);

        // Keep trying to connect to server even if camera fails
        // so we can show status
        setTimeout(() => {
            connectToServer();
        }, 1000);
    }
}

// === CAMERA ===
async function startCamera() {
    console.log('📷 Requesting camera access...');

    // Ask for camera (back camera preferred on phones) and microphone
    videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: 'environment', // Use back camera
            width: { ideal: 1920 },
            height: { ideal: 1080 }
        },
        audio: true // We need audio for syncing later
    });

    // Show the camera preview on screen
    videoPreview.srcObject = videoStream;
    console.log('✅ Camera started');
    updateStatus('Camera active');
}

// === CONTINUOUS RECORDING ===
async function startContinuousRecording() {
    console.log('🎬 Starting continuous recording...');

    // Create a recorder that saves video in WebM format
    mediaRecorder = new MediaRecorder(videoStream, {
        mimeType: 'video/webm;codecs=vp8,opus',
        videoBitsPerSecond: 2500000 // 2.5 Mbps - good quality
    });

    // Every time we get a chunk of video (every 1 second)
    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            recordedChunks.push({
                data: event.data,
                timestamp: Date.now()
            });

            // Keep only the last 5 seconds
            // Remove chunks older than 5 seconds
            const cutoffTime = Date.now() - BUFFER_DURATION;
            recordedChunks = recordedChunks.filter(chunk => chunk.timestamp > cutoffTime);

            console.log(`📼 Buffer: ${recordedChunks.length} chunks (last ${BUFFER_DURATION/1000}s)`);
        }
    };

    // Start recording in chunks
    mediaRecorder.start(CHUNK_DURATION); // Get a chunk every 1 second
    console.log('✅ Continuous recording started');
    updateStatus('Recording buffer active');
}

// === AUDIO SYNC TONE ===
function setupAudio() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    console.log('🔊 Audio context ready for sync tones');
}

function playSyncTone() {
    // Play a 1000Hz beep for 0.5 seconds
    // This beep will be in the video and helps sync in post-production
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 1000; // 1000 Hz tone
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);

    console.log('🔊 Sync tone played');
}

// === SERVER CONNECTION ===
function connectToServer() {
    console.log('🌐 Connecting to server...');
    socket = io(SERVER_URL);

    // When connected
    socket.on('connect', () => {
        console.log('✅ Connected to server');
        updateStatus('Connected to server');
    });

    // Server tells us if we're master or client
    socket.on('role', (data) => {
        myRole = data.role;
        sessionId = data.sessionId;

        roleDisplay.textContent = myRole === 'master' ? '👑 MASTER' : '📱 CLIENT';
        roleDisplay.className = `role ${myRole}`;

        if (myRole === 'master') {
            captureBtn.style.display = 'flex';
            captureBtn.disabled = false;
            updateStatus('You control the capture - press button when ready');
        } else {
            captureBtn.style.display = 'none';
            updateStatus('Waiting for master to trigger capture...');
        }

        console.log(`🎭 Role assigned: ${myRole.toUpperCase()}`);
    });

    // Status update (how many phones connected)
    socket.on('status', (data) => {
        clientCount.textContent = `${data.totalClients} phone${data.totalClients !== 1 ? 's' : ''} connected`;
    });

    // THE BIG MOMENT: Master pressed capture!
    socket.on('capture', async (data) => {
        console.log('🔴 CAPTURE TRIGGERED!');
        console.log(`   Timestamp: ${data.timestamp}`);
        console.log(`   Folder: ${data.folderName}`);

        // Play sync beep FIRST, then wait 1 second before saving
        // This puts the beep at the START of the 6-second video
        playSyncTone();

        // Wait 1 second for the beep to be captured in the buffer
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Now save the video (which includes the beep at the beginning)
        await saveVideo(data);
    });

    // If disconnected
    socket.on('disconnect', () => {
        console.log('❌ Disconnected from server');
        updateStatus('Disconnected - trying to reconnect...');
    });
}

// === CAPTURE BUTTON ===
captureBtn.addEventListener('click', () => {
    if (myRole === 'master' && !isUploading) {
        console.log('🎬 Master pressed CAPTURE button');
        socket.emit('trigger-capture');
    }
});

// === SAVE VIDEO ===
async function saveVideo(captureData) {
    if (isUploading) {
        console.log('⏳ Already uploading, ignoring this capture');
        return;
    }

    isUploading = true;
    showMessage('💾 Saving video...');

    try {
        // Stop and restart the recorder to get the final chunk
        mediaRecorder.stop();

        // Wait a moment for the final chunk
        await new Promise(resolve => setTimeout(resolve, 500));

        // Combine all chunks into one video file
        const videoBlob = new Blob(
            recordedChunks.map(chunk => chunk.data),
            { type: 'video/webm' }
        );

        console.log(`📦 Video size: ${(videoBlob.size / 1024 / 1024).toFixed(2)} MB`);

        // Create a unique filename
        const filename = `capture_${captureData.sessionId}_${socket.id}_${captureData.timestamp}.webm`;

        // Create metadata (info about this video)
        const metadata = {
            filename: filename,
            folderName: captureData.folderName,
            sessionId: captureData.sessionId,
            deviceId: socket.id,
            captureTimestamp: captureData.timestamp,
            localTimestamp: Date.now(),
            duration: BUFFER_DURATION,
            size: videoBlob.size,
            role: myRole
        };

        console.log('📤 Uploading to S3...');
        await uploadToS3(videoBlob, metadata);

        showMessage('✅ Video saved successfully!', 2000);
        console.log('✅ Upload complete');

        // Restart continuous recording
        recordedChunks = [];
        mediaRecorder.start(CHUNK_DURATION);

    } catch (error) {
        console.error('❌ Save failed:', error);
        showMessage('❌ Upload failed. Check console for details.');
    } finally {
        isUploading = false;
    }
}

// === UPLOAD TO S3 ===
async function uploadToS3(videoBlob, metadata) {
    // Convert video to base64 for upload
    const videoData = await blobToBase64(videoBlob);

    // Send to our server, which will upload to S3
    const response = await fetch(`${SERVER_URL}/upload`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            videoData: videoData,
            metadata: metadata
        })
    });

    if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('📤 Upload response:', result);

    // Tell the server we're done
    socket.emit('video-uploaded', { filename: metadata.filename });

    return result;
}

// Helper: Convert blob to base64
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// === UI HELPERS ===
function updateStatus(text) {
    statusText.textContent = text;
}

function showMessage(text, duration = null) {
    messageDiv.textContent = text;
    messageDiv.classList.add('show');

    if (duration) {
        setTimeout(() => {
            messageDiv.classList.remove('show');
        }, duration);
    }
}

// Handle errors
window.addEventListener('error', (event) => {
    console.error('💥 Error:', event.error);
});
