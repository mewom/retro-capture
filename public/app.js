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
let hasFlash = false;    // Does this device have flash capability?
let isFlashPhone = false; // Is this the designated flash phone?

// === ELEMENTS (buttons, text, etc) ===
const videoPreview = document.getElementById('video-preview');
const roleDisplay = document.getElementById('role-display');
const statusText = document.getElementById('status-text');
const clientCount = document.getElementById('client-count');
const captureBtn = document.getElementById('capture-btn');
const messageDiv = document.getElementById('message');
const flashSelector = document.getElementById('flash-selector');
const flashPhoneSelect = document.getElementById('flash-phone-select');

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
        hasFlash = await startCamera();

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

    // Check if this camera has flash/torch capability
    const videoTrack = videoStream.getVideoTracks()[0];
    const capabilities = videoTrack.getCapabilities();
    const hasFlash = capabilities.torch || false;

    console.log('✅ Camera started');
    console.log(`📸 Flash available: ${hasFlash}`);
    updateStatus('Camera active');

    return hasFlash;
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

        // Send flash capability to server
        socket.emit('register-flash', { hasFlash });
        console.log(`📸 Registered flash capability: ${hasFlash}`);
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
            flashSelector.classList.add('show');
            updateStatus('You control the capture - press button when ready');
        } else {
            captureBtn.style.display = 'none';
            flashSelector.classList.remove('show');
            updateStatus('Waiting for master to trigger capture...');
        }

        console.log(`🎭 Role assigned: ${myRole.toUpperCase()}`);
    });

    // Master receives list of flash-capable phones
    socket.on('flash-phones-list', (data) => {
        if (myRole === 'master') {
            console.log('📋 Received flash phones list:', data.phones);
            updateFlashPhonesList(data.phones);
        }
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

        // Play sync beep/flash IMMEDIATELY
        // This captures the moment, then we record for 1 more second
        playSyncTone();

        // Trigger flash if this is the flash phone
        if (isFlashPhone && hasFlash) {
            await triggerFlash();
        }

        // Wait 1 second AFTER the beep/flash to capture it in the buffer
        // This makes the beep/flash appear at second 5-6 of the 6-second video
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Now save: previous 5 seconds + the 1 second with beep/flash = 6 seconds total
        await saveVideo(data);
    });

    // When master designates this as the flash phone
    socket.on('set-flash-phone', (data) => {
        isFlashPhone = data.isFlashPhone;
        console.log(`⚡ Flash phone status: ${isFlashPhone}`);

        if (isFlashPhone) {
            showMessage('⚡ FLASH PHONE', 3000);
            updateFlashIndicator(true);
        } else {
            updateFlashIndicator(false);
        }
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

// === FLASH PHONE SELECTOR ===
flashPhoneSelect.addEventListener('change', () => {
    const selectedPhoneId = flashPhoneSelect.value;
    console.log(`⚡ Master selected flash phone: ${selectedPhoneId}`);
    socket.emit('select-flash-phone', { phoneId: selectedPhoneId });
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

// === FLASH CONTROL ===
async function triggerFlash() {
    try {
        const videoTrack = videoStream.getVideoTracks()[0];

        // Turn flash ON
        await videoTrack.applyConstraints({
            advanced: [{ torch: true }]
        });
        console.log('⚡ Flash ON');

        // Keep flash on for 0.5 seconds (same duration as beep)
        await new Promise(resolve => setTimeout(resolve, 500));

        // Turn flash OFF
        await videoTrack.applyConstraints({
            advanced: [{ torch: false }]
        });
        console.log('⚡ Flash OFF');
    } catch (error) {
        console.error('❌ Flash error:', error);
    }
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

function updateFlashIndicator(isFlash) {
    // Add or remove flash indicator in the role display
    if (isFlash) {
        roleDisplay.textContent = `${roleDisplay.textContent} ⚡ FLASH`;
        roleDisplay.classList.add('flash-phone');
    } else {
        roleDisplay.textContent = roleDisplay.textContent.replace(' ⚡ FLASH', '');
        roleDisplay.classList.remove('flash-phone');
    }
}

function updateFlashPhonesList(phones) {
    // Clear current options except "No Flash"
    flashPhoneSelect.innerHTML = '<option value="none">No Flash</option>';

    // Add each flash-capable phone to the dropdown
    phones.forEach(phone => {
        const option = document.createElement('option');
        option.value = phone.id;
        option.textContent = phone.id === socket.id ?
            `This Phone (${phone.role})` :
            `Phone ${phone.id.substring(0, 8)}... (${phone.role})`;
        flashPhoneSelect.appendChild(option);
    });

    console.log(`📋 Updated flash phones dropdown: ${phones.length} phones`);
}

// Handle errors
window.addEventListener('error', (event) => {
    console.error('💥 Error:', event.error);
});
