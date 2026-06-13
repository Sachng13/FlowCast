/**
 * FlowCast — Background Service Worker
 * 
 * Central orchestrator for the recording lifecycle.
 * 
 * State Machine:
 *   idle → preparing → countdown → recording ⇄ paused → processing → idle
 * 
 * Responsibilities:
 *   1. Receive recording commands from the Popup UI
 *   2. Create / destroy the Offscreen Document (media capture engine)
 *   3. Inject / remove Content Scripts (camera bubble, controls, annotations)
 *   4. Route messages between all extension contexts
 *   5. Handle edge cases: tab close, tab navigation, permission errors
 *   6. Open the Preview page when recording is complete
 */

// ============================================================
//  STATE
// ============================================================

const state = {
  status: 'idle',       // idle | preparing | countdown | recording | paused | processing
  tabId: null,          // The tab being recorded (for content script communication)
  settings: null,       // Recording settings from the popup
  recordingId: null,    // Unique ID for the current recording
  startTime: null,      // Timestamp when recording started
};

// ============================================================
//  MESSAGE ROUTER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Route the message to the appropriate handler
  routeMessage(message, sender, sendResponse);
  // Return true to keep the message channel open for async sendResponse calls
  return true;
});

async function routeMessage(message, sender, sendResponse) {
  try {
    switch (message.type) {

      // ── From Popup ─────────────────────────────────────────
      case 'START_RECORDING':
        await onStartRecording(message.settings);
        sendResponse({ success: true });
        break;

      case 'GET_STATE':
        sendResponse({ success: true, state: { ...state } });
        break;

      // ── From Offscreen Document ────────────────────────────
      case 'STREAMS_READY':
        await onStreamsReady();
        sendResponse({ success: true });
        break;

      case 'RECORDING_COMPLETE':
        await onRecordingComplete(message.recordingId);
        sendResponse({ success: true });
        break;

      case 'CAPTURE_ERROR':
        await onCaptureError(message.error);
        sendResponse({ success: true });
        break;

      // ── From Content Script ────────────────────────────────
      case 'COUNTDOWN_COMPLETE':
        await onCountdownComplete();
        sendResponse({ success: true });
        break;

      case 'STOP_RECORDING':
        await onStopRecording();
        sendResponse({ success: true });
        break;

      case 'PAUSE_RECORDING':
        await onPauseRecording();
        sendResponse({ success: true });
        break;

      case 'RESUME_RECORDING':
        await onResumeRecording();
        sendResponse({ success: true });
        break;

      case 'OFFSCREEN_MUTE_MIC':
      case 'OFFSCREEN_UNMUTE_MIC':
        try {
          chrome.runtime.sendMessage(message);
        } catch (_) {}
        sendResponse({ success: true });
        break;

      default:
        // Unknown message — ignore silently (may be for another listener)
        break;
    }
  } catch (err) {
    console.error('[FlowCast SW] Error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ============================================================
//  RECORDING LIFECYCLE HANDLERS
// ============================================================

/**
 * Step 1: User clicks "Start Recording" in the popup.
 * → Create the offscreen document and ask it to acquire media streams.
 */
async function onStartRecording(settings) {
  console.log('[FlowCast SW] Start recording requested', settings);

  // Determine the active tab (where we'll inject content scripts)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');

  // Generate a unique recording ID
  const recordingId = `rec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // Update state
  Object.assign(state, {
    status: 'preparing',
    tabId: tab.id,
    settings,
    recordingId,
  });

  // Persist state so we can recover if the service worker restarts
  await chrome.storage.session.set({ flowcast_state: { ...state } });

  // Create the offscreen document (our recording engine)
  await ensureOffscreenDocument();

  // Tell the offscreen document to acquire screen + mic streams
  // We use a small delay to ensure the offscreen document's listener is ready
  setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_INIT',
      settings,
      recordingId,
    });
  }, 200);
}

/**
 * Step 2: Offscreen document has successfully acquired all media streams.
 * → Inject the content script to show the countdown + camera bubble.
 */
async function onStreamsReady() {
  console.log('[FlowCast SW] Streams ready — injecting content script');

  try {
    // Inject CSS first, then JS
    await chrome.scripting.insertCSS({
      target: { tabId: state.tabId },
      files: ['content/content.css'],
    });

    await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      files: ['content/content.js'],
    });

    // Give the content script a moment to set up its message listener
    state.status = 'countdown';
    setTimeout(() => {
      chrome.tabs.sendMessage(state.tabId, {
        type: 'INIT_RECORDING_UI',
        settings: state.settings,
      });
    }, 150);

  } catch (err) {
    console.error('[FlowCast SW] Content script injection failed:', err);
    await onCaptureError('Failed to inject recording UI. Make sure you are on a regular web page.');
  }
}

/**
 * Step 3: The 3-2-1 countdown in the content script has finished.
 * → Tell the offscreen document to start the MediaRecorder.
 */
async function onCountdownComplete() {
  console.log('[FlowCast SW] Countdown done — starting MediaRecorder');

  state.status = 'recording';
  state.startTime = Date.now();

  // Tell offscreen to start recording
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_START_RECORDER' });

  // Tell content script to show the control bar
  chrome.tabs.sendMessage(state.tabId, { type: 'SHOW_CONTROLS' });
}

/**
 * User clicked Pause.
 */
async function onPauseRecording() {
  console.log('[FlowCast SW] Pausing');
  state.status = 'paused';
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_PAUSE' });
  chrome.tabs.sendMessage(state.tabId, { type: 'UPDATE_STATE', status: 'paused' });
}

/**
 * User clicked Resume.
 */
async function onResumeRecording() {
  console.log('[FlowCast SW] Resuming');
  state.status = 'recording';
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_RESUME' });
  chrome.tabs.sendMessage(state.tabId, { type: 'UPDATE_STATE', status: 'recording' });
}

/**
 * User clicked Stop.
 * → Tell the offscreen document to stop recording, compile, and save.
 */
async function onStopRecording() {
  console.log('[FlowCast SW] Stopping recording');
  state.status = 'processing';

  // Update content script UI to show "processing" state
  try {
    chrome.tabs.sendMessage(state.tabId, { type: 'UPDATE_STATE', status: 'processing' });
  } catch (_) { /* tab may be closed */ }

  // Tell offscreen to stop and save
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
}

/**
 * Offscreen document finished saving the recording to IndexedDB.
 * → Clean up and open the Preview page.
 */
async function onRecordingComplete(recordingId) {
  console.log('[FlowCast SW] Recording saved:', recordingId);

  // Remove content script UI
  try {
    chrome.tabs.sendMessage(state.tabId, { type: 'REMOVE_RECORDING_UI' });
  } catch (_) { /* tab may be closed */ }

  // Close the offscreen document
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) { /* might already be closed */ }

  // Open the preview page in a new tab
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview/preview.html?id=${recordingId}`),
  });

  // Reset state
  resetState();
}

/**
 * Something went wrong during capture.
 */
async function onCaptureError(error) {
  console.error('[FlowCast SW] Capture error:', error);

  // Clean up content script
  try {
    if (state.tabId) {
      chrome.tabs.sendMessage(state.tabId, { type: 'REMOVE_RECORDING_UI' });
    }
  } catch (_) {}

  // Close offscreen document
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) {}

  // Show error notification to the user using the badge
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);

  // Store error for the popup to display
  await chrome.storage.session.set({ flowcast_error: error });

  resetState();
}

function resetState() {
  Object.assign(state, {
    status: 'idle',
    tabId: null,
    settings: null,
    recordingId: null,
    startTime: null,
  });
  chrome.storage.session.set({ flowcast_state: { ...state } });
}

// ============================================================
//  OFFSCREEN DOCUMENT MANAGEMENT
// ============================================================

async function ensureOffscreenDocument() {
  // Check if an offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) {
    // Close the stale one and create a fresh instance
    await chrome.offscreen.closeDocument();
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [
      chrome.offscreen.Reason.USER_MEDIA,
      chrome.offscreen.Reason.DISPLAY_MEDIA,
    ],
    justification: 'Capturing screen, microphone, and system audio for recording.',
  });
}

// ============================================================
//  TAB LIFECYCLE — Handle edge cases during recording
// ============================================================

/**
 * If the user closes the tab being recorded, auto-stop.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId && state.status !== 'idle') {
    console.log('[FlowCast SW] Recorded tab closed — auto-stopping');
    onStopRecording();
  }
});

/**
 * If the user navigates to a new page in the recorded tab, re-inject the content script.
 * This ensures the camera bubble and controls persist across page loads.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== state.tabId) return;
  if (changeInfo.status !== 'complete') return;
  if (state.status !== 'recording' && state.status !== 'paused') return;

  console.log('[FlowCast SW] Tab navigated — re-injecting content script');

  setTimeout(async () => {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css'],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js'],
      });
      // Re-initialize the UI without countdown
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, {
          type: 'INIT_RECORDING_UI',
          settings: state.settings,
          skipCountdown: true,
        });
        // Immediately show controls since recording is already active
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: 'SHOW_CONTROLS' });
          chrome.tabs.sendMessage(tabId, { type: 'UPDATE_STATE', status: state.status });
        }, 100);
      }, 150);
    } catch (err) {
      console.error('[FlowCast SW] Re-injection failed:', err);
    }
  }, 300);
});

// ============================================================
//  INITIALIZATION — Recover state after service worker restart
// ============================================================

(async () => {
  const data = await chrome.storage.session.get('flowcast_state');
  if (data.flowcast_state && data.flowcast_state.status !== 'idle') {
    console.log('[FlowCast SW] Recovering state:', data.flowcast_state);
    Object.assign(state, data.flowcast_state);
  }
})();
