/**
 * FlowCast — Offscreen Recording Engine
 * 
 * This script runs inside an invisible offscreen document.
 * It handles all heavy media work:
 *   1. Screen capture via getDisplayMedia()
 *   2. Microphone capture via getUserMedia()
 *   3. Audio mixing (system audio + mic) via Web Audio API
 *   4. Recording via MediaRecorder → WebM
 *   5. Real-time transcription via Web Speech API
 *   6. Saving the final blob + transcript to IndexedDB
 */

// ============================================================
//  STATE
// ============================================================

let screenStream = null;   // MediaStream from getDisplayMedia
let micStream = null;      // MediaStream from getUserMedia (mic)
let combinedStream = null; // Mixed stream fed to MediaRecorder
let mediaRecorder = null;  // MediaRecorder instance
let audioContext = null;   // Web Audio API context for mixing
let recordedChunks = [];   // Raw data chunks from MediaRecorder
let currentSettings = {};  // Recording settings
let currentRecordingId = null;
let recordingStartTime = null;
let isMicMuted = false;
let hasError = false;

// ============================================================
//  MESSAGE LISTENER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'OFFSCREEN_INIT':
      handleInit(message.settings, message.recordingId);
      sendResponse({ success: true });
      break;

    case 'OFFSCREEN_START_RECORDER':
      handleStartRecorder();
      sendResponse({ success: true });
      break;

    case 'OFFSCREEN_PAUSE':
      handlePause();
      sendResponse({ success: true });
      break;

    case 'OFFSCREEN_RESUME':
      handleResume();
      sendResponse({ success: true });
      break;

    case 'OFFSCREEN_STOP':
      handleStop();
      sendResponse({ success: true });
      break;

    case 'OFFSCREEN_MUTE_MIC':
      isMicMuted = true;
      if (micStream) {
        micStream.getAudioTracks().forEach(t => t.enabled = false);
      }
      sendResponse({ success: true });
      break;

    case 'OFFSCREEN_UNMUTE_MIC':
      isMicMuted = false;
      if (micStream) {
        micStream.getAudioTracks().forEach(t => t.enabled = true);
      }
      sendResponse({ success: true });
      break;

    default:
      break;
  }
  return true;
});

// ============================================================
//  STREAM ACQUISITION
// ============================================================

/**
 * Acquire screen and microphone streams based on user settings.
 * Once ready, notify the service worker.
 */
async function handleInit(settings, recordingId) {
  console.log('[FlowCast Offscreen] Initializing streams', settings);

  currentSettings = settings;
  currentRecordingId = recordingId;
  recordedChunks = [];
  hasError = false;

  try {
    // ── Screen Capture ─────────────────────────────────────
    const displayConstraints = {
      video: {
        // Request high quality; browser will downscale if needed
        width: { ideal: getResolutionWidth(settings.quality) },
        height: { ideal: getResolutionHeight(settings.quality) },
        frameRate: { ideal: 30 },
      },
      audio: true,  // Request system/tab audio
    };

    screenStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);

    // Listen for the user clicking "Stop sharing" in the browser's native UI
    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      console.log('[FlowCast Offscreen] Screen sharing stopped by user');
      handleStop();
    });

    // ── Microphone Capture ─────────────────────────────────
    if (settings.micEnabled !== false) {
      try {
        const audioConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        if (settings.micId && typeof settings.micId === 'string' && settings.micId.trim() !== '') {
          audioConstraints.deviceId = { exact: settings.micId };
        }
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
      } catch (micErr) {
        console.warn('[FlowCast Offscreen] Mic capture failed with exact ID, trying default:', micErr);
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
        } catch (fallbackErr) {
          console.warn('[FlowCast Offscreen] Default mic capture also failed:', fallbackErr);
          micStream = null;
        }
      }
    }

    // ── Combine Streams ────────────────────────────────────
    combinedStream = buildCombinedStream(screenStream, micStream);

    // Notify the service worker that streams are ready
    chrome.runtime.sendMessage({ type: 'STREAMS_READY' });

  } catch (err) {
    console.error('[FlowCast Offscreen] Stream acquisition failed:', err);

    // User cancelled the screen picker or permission was denied
    chrome.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      error: err.name === 'NotAllowedError'
        ? 'Screen sharing was cancelled or denied.'
        : `Failed to capture screen: ${err.message}`,
    });
  }
}

// ============================================================
//  AUDIO MIXING via Web Audio API
// ============================================================

/**
 * Merges the system audio (from screen capture) and the microphone audio
 * into a single stereo audio track. Returns a new MediaStream with the
 * screen video track + the mixed audio track.
 */
function buildCombinedStream(screen, mic) {
  const videoTrack = screen.getVideoTracks()[0];
  const systemAudioTracks = screen.getAudioTracks();
  const micAudioTracks = mic ? mic.getAudioTracks() : [];

  // If no audio at all, return video-only stream
  if (systemAudioTracks.length === 0 && micAudioTracks.length === 0) {
    return new MediaStream([videoTrack]);
  }

  // If only one audio source, no mixing needed
  if (systemAudioTracks.length === 0 && micAudioTracks.length > 0) {
    return new MediaStream([videoTrack, micAudioTracks[0]]);
  }
  if (systemAudioTracks.length > 0 && micAudioTracks.length === 0) {
    return new MediaStream([videoTrack, systemAudioTracks[0]]);
  }

  // Both audio sources — mix them using Web Audio API
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(e => console.warn('Failed to resume AudioContext:', e));
  }
  const destination = audioContext.createMediaStreamDestination();

  // System audio source
  const systemSource = audioContext.createMediaStreamSource(
    new MediaStream([systemAudioTracks[0]])
  );
  const systemGain = audioContext.createGain();
  systemGain.gain.value = 0.7; // Slightly lower system audio
  systemSource.connect(systemGain);
  systemGain.connect(destination);

  // Mic audio source
  const micSource = audioContext.createMediaStreamSource(
    new MediaStream([micAudioTracks[0]])
  );
  const micGain = audioContext.createGain();
  micGain.gain.value = 1.0;
  micSource.connect(micGain);
  micGain.connect(destination);

  // Build the final stream: screen video + mixed audio
  return new MediaStream([
    videoTrack,
    ...destination.stream.getAudioTracks(),
  ]);
}

// ============================================================
//  MEDIA RECORDER
// ============================================================

/**
 * Start the MediaRecorder. Called after the countdown finishes.
 */
function handleStartRecorder() {
  console.log('[FlowCast Offscreen] Starting MediaRecorder');

  if (!combinedStream) {
    console.error('[FlowCast Offscreen] No combined stream available');
    return;
  }

  const hasAudio = combinedStream && combinedStream.getAudioTracks().length > 0;
  const mimeType = getSupportedMimeType(hasAudio);

  const options = {
    mimeType,
    videoBitsPerSecond: getBitrate(currentSettings.quality),
  };

  mediaRecorder = new MediaRecorder(combinedStream, options);
  recordedChunks = [];

  // Collect data chunks every second for smoother saving
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    console.log('[FlowCast Offscreen] MediaRecorder stopped, saving...');
    if (hasError || recordedChunks.length === 0) {
      console.warn('[FlowCast Offscreen] Recording failed or empty, skipping save.');
      cleanupStreams();
      return;
    }
    await saveRecording();
  };

  mediaRecorder.onerror = (event) => {
    console.error('[FlowCast Offscreen] MediaRecorder error:', event.error);
    hasError = true;
    chrome.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      error: `Recording error: ${event.error?.message || 'Unknown error'}`,
    });
  };

  // Start recording with 1-second timeslices
  mediaRecorder.start(1000);
  recordingStartTime = Date.now();
}

function handlePause() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    console.log('[FlowCast Offscreen] Paused');
  }
}

function handleResume() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    console.log('[FlowCast Offscreen] Resumed');
  }
}

function handleStop() {
  console.log('[FlowCast Offscreen] Stopping...');

  // Stop the MediaRecorder (triggers onstop → saveRecording)
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    // If recorder was never started, just clean up
    cleanupStreams();
    chrome.runtime.sendMessage({
      type: 'RECORDING_COMPLETE',
      recordingId: currentRecordingId,
    });
  }
}

// ============================================================
//  SAVE RECORDING TO INDEXEDDB
// ============================================================

async function saveRecording() {
  try {
    // Compile all chunks into a single Blob
    const mimeType = mediaRecorder?.mimeType || 'video/webm';
    const blob = new Blob(recordedChunks, { type: mimeType });

    const duration = Date.now() - (recordingStartTime || Date.now());

    // Build the recording object
    const recording = {
      id: currentRecordingId,
      timestamp: Date.now(),
      duration,
      mimeType,
      size: blob.size,
      settings: { ...currentSettings },
      notes: [], // Initialize notes array
      blob,
    };

    // Save to IndexedDB (FlowCastDB is loaded from utils/db.js)
    await FlowCastDB.saveRecording(recording);

    console.log('[FlowCast Offscreen] Recording saved to IndexedDB:', currentRecordingId);

    // Clean up streams
    cleanupStreams();

    // Notify the service worker
    chrome.runtime.sendMessage({
      type: 'RECORDING_COMPLETE',
      recordingId: currentRecordingId,
    });

  } catch (err) {
    console.error('[FlowCast Offscreen] Failed to save recording:', err);
    chrome.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      error: `Failed to save recording: ${err.message}`,
    });
  }
}

function cleanupStreams() {
  // Stop all tracks in all streams
  [screenStream, micStream, combinedStream].forEach((stream) => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
  });

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  screenStream = null;
  micStream = null;
  combinedStream = null;
  mediaRecorder = null;
  recordedChunks = [];
}

// ============================================================
//  HELPERS
// ============================================================

function getResolutionWidth(quality) {
  switch (quality) {
    case '4k':   return 3840;
    case '1080p': return 1920;
    case '720p':
    default:      return 1280;
  }
}

function getResolutionHeight(quality) {
  switch (quality) {
    case '4k':   return 2160;
    case '1080p': return 1080;
    case '720p':
    default:      return 720;
  }
}

function getBitrate(quality) {
  switch (quality) {
    case '4k':    return 15_000_000; // 15 Mbps
    case '1080p': return 5_000_000;  //  5 Mbps
    case '720p':
    default:      return 2_500_000;  // 2.5 Mbps
  }
}

function getSupportedMimeType(hasAudio) {
  const candidates = hasAudio ? [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ] : [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return 'video/webm'; // Fallback
}
