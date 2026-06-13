/**
 * FlowCast — Popup Logic
 * 
 * Handles device enumeration, user preferences, and recording initiation.
 * Communicates with the Service Worker to start/manage recordings.
 */

// ============================================================
//  DOM REFERENCES
// ============================================================

const modeTabs      = document.querySelectorAll('.mode-tab');
const cameraSection = document.getElementById('camera-section');
const cameraSelect  = document.getElementById('camera-select');
const micSelect     = document.getElementById('mic-select');
const startBtn      = document.getElementById('start-btn');
const recordingView = document.getElementById('recording-active');
const errorBanner   = document.getElementById('error-banner');
const errorText     = document.getElementById('error-text');
const popupContainer = document.getElementById('popup-container');

// ============================================================
//  STATE
// ============================================================

let selectedMode = 'screen-cam'; // screen-cam | screen | cam

// ============================================================
//  INITIALIZATION
// ============================================================

async function checkPermissionsGranted() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices.filter(d => d.kind === 'audioinput');
    if (audioDevices.length === 0) return false;
    return audioDevices.some(d => d.label !== '');
  } catch (err) {
    return false;
  }
}

function showPermissionOverlay() {
  const overlay = document.getElementById('permission-overlay');
  if (overlay) overlay.style.display = 'flex';
  
  const grantBtn = document.getElementById('grant-permission-btn');
  if (grantBtn) {
    grantBtn.addEventListener('click', async () => {
      try {
        // Try to request permissions directly in the popup first
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasVideoInput = devices.some(d => d.kind === 'videoinput');
        
        const constraints = { audio: true };
        if (hasVideoInput) {
          constraints.video = true;
        }
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getTracks().forEach(t => t.stop());
        
        // Success! Hide overlay and initialize popup controls
        if (overlay) overlay.style.display = 'none';
        await checkCurrentState();
        await enumerateDevices();
        await loadSavedSettings();
        bindEvents();
      } catch (err) {
        console.warn("Failed to request inside popup, opening setup tab:", err);
        // Fallback: Open permissions setup page in a new tab
        chrome.tabs.create({
          url: chrome.runtime.getURL('preview/preview.html?setup=true')
        });
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const isGranted = await checkPermissionsGranted();
  if (!isGranted) {
    showPermissionOverlay();
    return;
  }
  await checkCurrentState();
  await enumerateDevices();
  await loadSavedSettings();
  bindEvents();
});

/**
 * Check if a recording is already in progress.
 * If so, show the "recording active" state instead of the controls.
 */
async function checkCurrentState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response?.success && response.state?.status !== 'idle') {
      showRecordingActive();
    }

    // Check for stored errors
    const data = await chrome.storage.session.get('flowcast_error');
    if (data.flowcast_error) {
      showError(data.flowcast_error);
      await chrome.storage.session.remove('flowcast_error');
    }
  } catch (err) {
    console.log('[FlowCast Popup] No active state');
  }
}

// ============================================================
//  DEVICE ENUMERATION
// ============================================================

async function enumerateDevices() {
  try {
    // Request a temporary stream to trigger the permission prompt
    // This is needed for enumerating device labels
    let tempStream = null;
    try {
      tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (_) {
      // If both fail, try audio only
      try {
        tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (__) {
        // Can't enumerate with labels — fallback to generic names
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();

    // Populate camera dropdown
    const cameras = devices.filter(d => d.kind === 'videoinput');
    cameraSelect.innerHTML = '';
    if (cameras.length === 0) {
      cameraSelect.innerHTML = '<option value="">No camera found</option>';
    } else {
      cameras.forEach((cam, i) => {
        const option = document.createElement('option');
        option.value = cam.deviceId;
        option.textContent = cam.label || `Camera ${i + 1}`;
        cameraSelect.appendChild(option);
      });
    }

    // Populate microphone dropdown
    const mics = devices.filter(d => d.kind === 'audioinput');
    micSelect.innerHTML = '';
    if (mics.length === 0) {
      micSelect.innerHTML = '<option value="">No microphone found</option>';
    } else {
      mics.forEach((mic, i) => {
        const option = document.createElement('option');
        option.value = mic.deviceId;
        option.textContent = mic.label || `Microphone ${i + 1}`;
        micSelect.appendChild(option);
      });
    }

    // Release the temporary stream
    if (tempStream) {
      tempStream.getTracks().forEach(t => t.stop());
    }
  } catch (err) {
    console.error('[FlowCast Popup] Device enumeration failed:', err);
    cameraSelect.innerHTML = '<option value="">Permission required</option>';
    micSelect.innerHTML = '<option value="">Permission required</option>';
  }
}

// ============================================================
//  SETTINGS PERSISTENCE
// ============================================================

async function loadSavedSettings() {
  try {
    const data = await chrome.storage.local.get('flowcast_settings');
    const settings = data.flowcast_settings;
    if (!settings) return;

    // Restore recording mode
    if (settings.mode) {
      selectedMode = settings.mode;
      modeTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === selectedMode);
      });
      updateModeVisibility();
    }

    // Restore quality
    if (settings.quality) {
      const radio = document.querySelector(`input[name="quality"][value="${settings.quality}"]`);
      if (radio) radio.checked = true;
    }

    // Restore selected devices (after enumeration)
    if (settings.camId && cameraSelect.querySelector(`option[value="${settings.camId}"]`)) {
      cameraSelect.value = settings.camId;
    }
    if (settings.micId && micSelect.querySelector(`option[value="${settings.micId}"]`)) {
      micSelect.value = settings.micId;
    }
  } catch (err) {
    console.log('[FlowCast Popup] No saved settings');
  }
}

async function saveSettings() {
  const settings = getCurrentSettings();
  await chrome.storage.local.set({ flowcast_settings: settings });
}

function getCurrentSettings() {
  const quality = document.querySelector('input[name="quality"]:checked')?.value || '1080p';
  return {
    mode: selectedMode,
    camId: cameraSelect.value || null,
    micId: micSelect.value || null,
    micEnabled: true,
    quality,
    camEnabled: selectedMode === 'screen-cam' || selectedMode === 'cam',
    screenEnabled: selectedMode === 'screen-cam' || selectedMode === 'screen',
  };
}

// ============================================================
//  EVENT HANDLERS
// ============================================================

function bindEvents() {
  // Mode tab switching
  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      selectedMode = tab.dataset.mode;
      updateModeVisibility();
      saveSettings();
    });
  });

  // Device & quality change → auto-save
  cameraSelect.addEventListener('change', saveSettings);
  micSelect.addEventListener('change', saveSettings);
  document.querySelectorAll('input[name="quality"]').forEach(radio => {
    radio.addEventListener('change', saveSettings);
  });

  // Start Recording button
  startBtn.addEventListener('click', handleStartRecording);
}

function updateModeVisibility() {
  // Hide camera dropdown when in "screen only" mode
  cameraSection.style.display = selectedMode === 'screen' ? 'none' : 'flex';
}

async function handleStartRecording() {
  // Prevent double-clicks
  startBtn.disabled = true;

  // Hide any previous errors
  errorBanner.style.display = 'none';

  const settings = getCurrentSettings();

  try {
    // Save settings before starting
    await saveSettings();

    // Send the start command to the Service Worker
    const response = await chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      settings,
    });

    if (response?.success) {
      // Close the popup — the content script will take over
      // Short delay so the user sees the button state change
      showRecordingActive();

      // Close popup after a moment
      setTimeout(() => window.close(), 800);
    } else {
      showError(response?.error || 'Failed to start recording');
      startBtn.disabled = false;
    }
  } catch (err) {
    console.error('[FlowCast Popup] Start recording error:', err);
    showError('Failed to communicate with the extension. Try reloading.');
    startBtn.disabled = false;
  }
}

// ============================================================
//  UI STATE CHANGES
// ============================================================

function showRecordingActive() {
  // Hide the controls and show the recording state
  document.querySelectorAll('.section, .start-btn, .footer').forEach(el => {
    el.style.display = 'none';
  });
  recordingView.style.display = 'flex';
}

function showError(message) {
  errorText.textContent = message;
  errorBanner.style.display = 'flex';
}
