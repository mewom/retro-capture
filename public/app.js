// This is the BRAIN of the phone app
// It handles: camera access, continuous recording, and saving videos

// === CONFIGURATION ===
const BUFFER_DURATION = 8000; // Keep last 8 seconds (8000 milliseconds)
const OVERLAP_MS = 200;       // 200ms overlap between segments to avoid gaps
const BEEP_AT_MS = 1000;      // Play beep at 1 second into segment (safer than end)
const SERVER_URL = window.location.origin; // Automatically use the server's address

// === GLOBAL VARIABLES ===
let socket;              // Connection to the server
let myRole = null;       // Am I 'conductor' or 'client'?
let sessionId = null;    // Unique ID for this capture session
let syncStarted = false; // Has the conductor started synchronized recording?
let videoStream;         // The camera feed (original from camera)
let mixedStream;         // Mixed stream with audio for beeps
let audioContext;        // For audio processing and beeps
let audioDestination;    // For mixing beeps into recording
let latestSegment = null; // The most recent complete 6-second segment (ready to upload)
let isUploading = false; // Are we currently uploading?
let hasFlash = false;    // Does this device have flash capability?
let isFlashPhone = false; // Is this the designated flash phone?
let segmentCount = 0;    // How many segments we've completed (for countdown)
let isRecordingActive = false; // State guard to prevent double starts

// Dual recorder state
let currentRecorder = null;  // { rec, chunks, startedAt }
let nextRecorder = null;     // For overlap handoff

// === ELEMENTS (buttons, text, etc) ===
const videoPreview = document.getElementById('video-preview');
const roleDisplay = document.getElementById('role-display');
const statusText = document.getElementById('status-text');
const clientCount = document.getElementById('client-count');
const syncBtn = document.getElementById('sync-btn');
const captureBtn = document.getElementById('capture-btn');
const messageDiv = document.getElementById('message');
const flashSelector = document.getElementById('flash-selector');
const flashPhoneSelect = document.getElementById('flash-phone-select');
const debugPanel = document.getElementById('debug-panel');
const debugToggle = document.getElementById('debug-toggle');
const debugClose = document.getElementById('debug-close');
const debugClear = document.getElementById('debug-clear');
const debugLogs = document.getElementById('debug-logs');

// === DEBUG SYSTEM ===
const debugLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.className = `debug-log ${type}`;
    logEntry.innerHTML = `<span class="debug-timestamp">[${timestamp}]</span> ${message}`;
    debugLogs.appendChild(logEntry);
    debugLogs.scrollTop = debugLogs.scrollHeight;

    // Also log to console
    console.log(`[${type.toUpperCase()}] ${message}`);
};

// Debug panel controls
debugToggle.addEventListener('click', () => {
    debugPanel.classList.remove('hidden');
    debugToggle.classList.add('panel-open');
});

debugClose.addEventListener('click', () => {
    debugPanel.classList.add('hidden');
    debugToggle.classList.remove('panel-open');
});

debugClear.addEventListener('click', () => {
    debugLogs.innerHTML = '';
    debugLog('Debug log cleared', 'info');
});

// === STARTUP ===
debugLog('📱 Retro Capture App Starting...', 'info');

// Show start button for Safari compatibility
showMessage('📱 TAP SCREEN TO START', null);
document.body.addEventListener('click', startApp, { once: true });
document.body.addEventListener('touchstart', startApp, { once: true });

async function startApp() {
    debugLog('🎬 User tapped - starting app...', 'info');
    showMessage('⏳ Starting camera...', null);
    await init();
}

// Initialize everything
async function init() {
    try {
        // Step 1: Get camera and microphone access
        await startCamera();

        // Step 2: Set up audio context and mixed stream for beeps
        setupAudioMixing();

        // Step 3: Connect to the server (will wait for sync signal before recording)
        connectToServer();

        debugLog('✅ App initialized successfully', 'success');

        // Hide the message after successful init
        setTimeout(() => {
            messageDiv.classList.remove('show');
        }, 2000);
    } catch (error) {
        debugLog(`❌ Initialization failed: ${error.message}`, 'error');
        const errorMsg = error.message || error.toString();
        showMessage(`❌ CAMERA ERROR\n\n${errorMsg}\n\niPhone: Settings → Safari → Camera → Allow\n\nThen refresh this page.`, null);

        // Keep trying to connect to server even if camera fails
        setTimeout(() => {
            connectToServer();
        }, 1000);
    }
}

// === CAMERA ===
async function startCamera() {
    debugLog('📷 Requesting camera access...', 'info');

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

    // Test if this camera has flash/torch capability (with real test, not just capabilities)
    const videoTrack = videoStream.getVideoTracks()[0];
    hasFlash = await detectTorchCapability(videoTrack);

    debugLog('✅ Camera started', 'success');
    debugLog(`📸 Flash capability: ${hasFlash}`, 'info');
    updateStatus('Camera active');
}

// Real torch capability test - actually tries to enable torch
async function detectTorchCapability(videoTrack) {
    try {
        // Try to enable torch
        await videoTrack.applyConstraints({ advanced: [{ torch: true }] });
        // If successful, turn it back off
        await videoTrack.applyConstraints({ advanced: [{ torch: false }] });
        debugLog('✅ Torch test: PASSED', 'success');
        return true;
    } catch (err) {
        debugLog(`⚠️ Torch test: FAILED (${err.message})`, 'warning');
        return false;
    }
}

// === AUDIO MIXING FOR IN-FILE BEEPS ===
// This creates a mixed audio stream so beeps are GUARANTEED to be in the recording
function setupAudioMixing() {
    debugLog('🔊 Setting up audio mixing...', 'info');

    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Get the mic audio from the camera stream
    const audioTrack = videoStream.getAudioTracks()[0];
    const micSource = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));

    // Create destination for mixed audio
    audioDestination = audioContext.createMediaStreamDestination();

    // Connect mic to destination (so mic audio is recorded)
    micSource.connect(audioDestination);

    // Create mixed stream: video from camera + mixed audio (mic + future beeps)
    const videoTrack = videoStream.getVideoTracks()[0];
    mixedStream = new MediaStream([
        videoTrack,
        audioDestination.stream.getAudioTracks()[0]
    ]);

    debugLog('✅ Audio mixing ready - beeps will be recorded in-file', 'success');
}

// Play beep that gets mixed into the recording (guaranteed to be in the file)
function playInFileBeep(durationMs = 500, frequency = 1000) {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    gain.gain.value = 0.2; // Not too loud to avoid saturation
    osc.frequency.value = frequency;
    osc.type = 'sine';

    osc.connect(gain);
    gain.connect(audioDestination); // Connect to recording destination
    gain.connect(audioContext.destination); // Also play through speakers

    osc.start(audioContext.currentTime);
    osc.stop(audioContext.currentTime + (durationMs / 1000));

    // Clean up
    setTimeout(() => {
        osc.disconnect();
        gain.disconnect();
    }, durationMs);

    debugLog(`🔊 In-file beep: ${frequency}Hz for ${durationMs}ms`, 'info');
}

// === ROTATING SEGMENTS WITH DUAL-RECORDER OVERLAP ===
// Prevents dropped frames between segments by overlapping recorders
async function startRotatingSegments() {
    if (isRecordingActive) {
        debugLog('⚠️ Recording already active, skipping', 'warning');
        return;
    }

    isRecordingActive = true;
    debugLog('🎬 Starting rotating segments system...', 'info');

    // Start first recorder
    currentRecorder = await createRecorder(mixedStream);
    currentRecorder.rec.start();
    debugLog('📼 First segment recording started', 'success');

    // Schedule the rotating segment loop
    scheduleNextSegment();
}

// Helper: Create a new recorder with chunk collection
async function createRecorder(stream) {
    // Check what mimeTypes are supported (only once)
    if (segmentCount === 0) {
        const supportedTypes = [
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=vp9,opus',
            'video/webm'
        ];

        for (const type of supportedTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                debugLog(`✅ Using mimeType: ${type}`, 'success');
                break;
            }
        }
    }

    const recorderOptions = {
        mimeType: 'video/webm;codecs=vp8,opus',
        videoBitsPerSecond: 3000000 // 3 Mbps for good quality
    };

    const rec = new MediaRecorder(stream, recorderOptions);
    const chunks = [];

    rec.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            chunks.push(event.data);
        }
    };

    return { rec, chunks, startedAt: performance.now() };
}

// Schedule the next segment rotation
function scheduleNextSegment() {
    // NOTE: We don't beep during rotation anymore - only when capture is triggered

    // Start overlap recorder before stopping current
    setTimeout(async () => {
        // Clone the stream for next recorder
        const clonedStream = mixedStream.clone();
        nextRecorder = await createRecorder(clonedStream);
        nextRecorder.rec.start();

        debugLog(`🎬 Next recorder started (overlap)`, 'info');

        // Wait for overlap period
        setTimeout(async () => {
            // Stop current recorder
            const done = new Promise(resolve => {
                currentRecorder.rec.onstop = resolve;
            });
            currentRecorder.rec.stop();
            await done;

            // Create blob from completed segment
            latestSegment = new Blob(currentRecorder.chunks, {
                type: currentRecorder.rec.mimeType
            });
            segmentCount++;

            const sizeMB = (latestSegment.size / 1024 / 1024).toFixed(2);
            debugLog(`✅ Segment #${segmentCount} complete: ${sizeMB} MB`, 'success');

            // Update UI
            updateBufferCountdown();

            // Promote next recorder to current
            currentRecorder = nextRecorder;
            nextRecorder = null;

            // Schedule next rotation (unless we're uploading)
            if (!isUploading) {
                scheduleNextSegment();
            }
        }, OVERLAP_MS);

    }, BUFFER_DURATION - OVERLAP_MS);
}

// === BUFFER COUNTDOWN ===
// Show countdown timer until first segment is ready
function updateBufferCountdown() {
    if (segmentCount >= 1) {
        // At least one segment is ready
        captureBtn.disabled = false;
        if (myRole === 'conductor') {
            updateStatus('Ready to capture!');
        } else {
            updateStatus('Waiting for conductor to capture...');
        }
    } else {
        // Still building first segment (8 seconds)
        const remainingSeconds = Math.ceil((BUFFER_DURATION - (performance.now() - (currentRecorder?.startedAt || 0))) / 1000);
        captureBtn.disabled = true;
        updateStatus(`Building buffer... ${Math.max(0, remainingSeconds)}s until ready`);

        // Check again in 1 second
        setTimeout(updateBufferCountdown, 1000);
    }
}

// === SERVER CONNECTION ===
function connectToServer() {
    // Prevent multiple connections
    if (socket && socket.connected) {
        debugLog('⚠️ Already connected to server', 'warning');
        return;
    }

    debugLog('🌐 Connecting to server...', 'info');
    socket = io(SERVER_URL);

    // When connected
    socket.on('connect', () => {
        console.log('✅ Connected to server');
        updateStatus('Connected to server');

        // Send flash capability to server
        socket.emit('register-flash', { hasFlash });
        console.log(`📸 Registered flash capability: ${hasFlash}`);
    });

    // Server tells us if we're conductor or client
    socket.on('role', (data) => {
        // Don't allow role changes after initial assignment (prevents bugs from duplicate connections)
        if (myRole !== null && myRole !== data.role) {
            debugLog(`⚠️ Ignoring role change from ${myRole} to ${data.role}`, 'warning');
            return;
        }

        myRole = data.role;
        sessionId = data.sessionId;
        syncStarted = data.syncStarted || false;

        roleDisplay.textContent = myRole === 'conductor' ? '🎵 CONDUCTOR' : '📱 CLIENT';
        roleDisplay.className = `role ${myRole}`;

        if (myRole === 'conductor') {
            syncBtn.style.display = syncStarted ? 'none' : 'flex';
            captureBtn.style.display = syncStarted ? 'flex' : 'none';
            captureBtn.disabled = !syncStarted;
            flashSelector.classList.add('show');
            updateStatus(syncStarted ? 'Ready - waiting for buffer...' : 'Press START SYNC to begin');
        } else {
            syncBtn.style.display = 'none';
            captureBtn.style.display = 'none';
            flashSelector.classList.remove('show');
            updateStatus(syncStarted ? 'Waiting for conductor to capture...' : 'Waiting for conductor to start sync...');
        }

        debugLog(`🎭 Role assigned: ${myRole.toUpperCase()}`, 'info');

        // If sync already started, begin recording
        if (syncStarted && !isRecordingActive) {
            startRotatingSegments();
        }
    });

    // Conductor receives list of flash-capable phones
    socket.on('flash-phones-list', (data) => {
        if (myRole === 'conductor') {
            debugLog('📋 Received flash phones list: ' + data.phones.length, 'info');
            updateFlashPhonesList(data.phones);
        }
    });

    // Status update (how many phones connected)
    socket.on('status', (data) => {
        clientCount.textContent = `${data.totalClients} phone${data.totalClients !== 1 ? 's' : ''} connected`;
    });

    // SYNC COUNTDOWN: Server is counting down
    socket.on('sync-countdown', (data) => {
        debugLog(`⏱️ Countdown: ${data.count}`, 'info');
        syncStarted = true;

        // Hide sync button, show capture button for conductor
        if (myRole === 'conductor') {
            syncBtn.style.display = 'none';
            captureBtn.style.display = 'flex';
            captureBtn.disabled = true; // Will enable after first segment
            updateStatus(`Starting in ${data.count}s...`);
        } else {
            updateStatus(`Starting in ${data.count}s...`);
        }
    });

    // SYNC GO: Server says start NOW
    socket.on('sync-go', async () => {
        debugLog('🚀 GO! STARTING RECORDING NOW (synchronized)', 'success');
        updateStatus('Recording started...');
        await startRotatingSegments();
    });

    // THE BIG MOMENT: Conductor pressed capture!
    socket.on('capture', async (data) => {
        debugLog('🔴 CAPTURE TRIGGERED!', 'success');
        debugLog(`   Timestamp: ${data.timestamp}`, 'info');
        debugLog(`   Folder: ${data.folderName}`, 'info');

        // Play beep immediately (goes into current segment being recorded)
        playInFileBeep(500, 1000);

        // Trigger flash if this is the flash phone
        if (isFlashPhone && hasFlash) {
            await triggerFlash();
        }

        // CRITICAL: Wait for the CURRENT segment (with beep) to complete
        // We need to wait for the current 6s cycle to finish, not use the old segment
        debugLog('⏳ Waiting for current segment (with beep) to complete...', 'info');

        // Set up a one-time listener for the next segment completion
        const waitForSegmentWithBeep = new Promise(resolve => {
            const originalCount = segmentCount;
            const checkInterval = setInterval(() => {
                if (segmentCount > originalCount) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });

        await waitForSegmentWithBeep;
        debugLog('✅ Segment with beep ready!', 'success');

        // Now save the segment that has the beep
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

// === SYNC BUTTON ===
syncBtn.addEventListener('click', () => {
    debugLog(`🎬 SYNC button clicked. Role: ${myRole}, syncStarted: ${syncStarted}`, 'info');

    if (myRole !== 'conductor') {
        debugLog(`❌ Cannot sync: Not conductor (role is ${myRole})`, 'error');
        return;
    }

    if (syncStarted) {
        debugLog('❌ Cannot sync: Already started', 'error');
        return;
    }

    if (!socket || !socket.connected) {
        debugLog('❌ Cannot sync: Not connected to server', 'error');
        return;
    }

    debugLog('✅ Emitting start-sync event', 'success');
    socket.emit('start-sync');
});

// === CAPTURE BUTTON ===
captureBtn.addEventListener('click', () => {
    if (myRole === 'conductor' && !isUploading && syncStarted) {
        debugLog('🔴 Conductor pressed CAPTURE button', 'success');
        socket.emit('trigger-capture');
    }
});

// === FLASH PHONE SELECTOR ===
flashPhoneSelect.addEventListener('change', () => {
    const selectedPhoneId = flashPhoneSelect.value;
    debugLog(`⚡ Conductor selected flash phone: ${selectedPhoneId}`, 'info');
    socket.emit('select-flash-phone', { phoneId: selectedPhoneId });
});

// === SAVE VIDEO ===
async function saveVideo(captureData) {
    if (isUploading) {
        debugLog('⏳ Already uploading, ignoring this capture', 'warning');
        return;
    }

    // Check if we have a segment ready
    if (!latestSegment) {
        debugLog('❌ No segment ready yet - still building first 6s buffer', 'error');
        showMessage('⏳ Wait for buffer to build...', 2000);
        return;
    }

    isUploading = true;
    showMessage('💾 Saving video...');
    debugLog('💾 Starting video save process...', 'info');

    try {
        // Use the latest complete segment (already a valid video file)
        const videoBlob = latestSegment;
        const videoSizeMB = (videoBlob.size / 1024 / 1024).toFixed(2);
        debugLog(`📦 Using latest segment: ${videoSizeMB} MB`, 'success');

        // Verify WebM header
        const headerCheck = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const arr = new Uint8Array(reader.result);
                const header = Array.from(arr.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                debugLog(`🔍 Blob header: ${header} (expect: 1a 45 df a3)`, header === '1a 45 df a3' ? 'success' : 'warning');
                resolve(header);
            };
            reader.readAsArrayBuffer(videoBlob.slice(0, 4));
        });

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

        debugLog(`📤 Uploading ${filename} to S3...`, 'info');
        debugLog(`📁 Folder: ${captureData.folderName}`, 'info');
        await uploadToS3(videoBlob, metadata);

        showMessage('✅ Video saved successfully!', 2000);
        debugLog('✅ Upload complete! Rotating segments continue...', 'success');

        // Release blob memory
        latestSegment = null;

        // Restart rotating segments if they stopped during upload
        if (!isRecordingActive || !currentRecorder) {
            debugLog('🔄 Restarting rotating segments...', 'info');
            isRecordingActive = false;
            await startRotatingSegments();
        } else {
            // Resume segment scheduling
            scheduleNextSegment();
        }

    } catch (error) {
        debugLog(`❌ Save failed: ${error.message}`, 'error');
        debugLog(`❌ Error stack: ${error.stack}`, 'error');
        showMessage('❌ Upload failed. Check debug panel for details.');

        // Restart recording system
        isRecordingActive = false;
        await startRotatingSegments();
    } finally {
        isUploading = false;
    }
}

// === UPLOAD TO S3 ===
async function uploadToS3(videoBlob, metadata) {
    debugLog(`🔧 Creating FormData for upload...`, 'info');
    debugLog(`   Blob size: ${videoBlob.size} bytes`, 'info');
    debugLog(`   Blob type: ${videoBlob.type}`, 'info');

    // Use FormData to send binary video file (no base64 conversion)
    const formData = new FormData();
    formData.append('video', videoBlob, metadata.filename);
    formData.append('metadata', JSON.stringify(metadata));

    debugLog(`📡 Sending POST to ${SERVER_URL}/upload`, 'info');

    // Send to our server, which will upload to S3
    const response = await fetch(`${SERVER_URL}/upload`, {
        method: 'POST',
        body: formData // Send as multipart/form-data, not JSON
    });

    debugLog(`📡 Server response status: ${response.status} ${response.statusText}`, response.ok ? 'success' : 'error');

    if (!response.ok) {
        const errorText = await response.text();
        debugLog(`❌ Server error response: ${errorText}`, 'error');
        throw new Error(`Upload failed: ${response.statusText}`);
    }

    const result = await response.json();
    debugLog(`📤 Upload response: ${JSON.stringify(result)}`, 'success');

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

// Old buffer countdown functions removed - using the new updateBufferCountdown() above

// Handle errors
window.addEventListener('error', (event) => {
    console.error('💥 Error:', event.error);
});
