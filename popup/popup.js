/**
 * FlowCast — Popup Logic
 * Small extension popup with inline permissions and recording controls.
 */

const modeTabs       = document.querySelectorAll('.mode-tab');
const cameraSection  = document.getElementById('camera-section');
const cameraSelect   = document.getElementById('camera-select');
const micSelect      = document.getElementById('mic-select');
const startBtn       = document.getElementById('start-btn');
const recordingView  = document.getElementById('recording-active');
const errorBanner    = document.getElementById('error-banner');
const errorText      = document.getElementById('error-text');
const deviceStatus   = document.getElementById('device-status');
const camChip        = document.getElementById('cam-chip');
const micChip        = document.getElementById('mic-chip');

let selectedMode = 'screen-cam';
let eventsBound = false;
let previewStream = null;

// ── Permissions ────────────────────────────────────────────

async function checkPermissionsGranted() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some(d =>
      (d.kind === 'audioinput' || d.kind === 'videoinput') && d.label !== ''
    );
  } catch (_) {
    return false;
  }
}

async function requestPermissionsInPopup() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: { width: { ideal: 640 }, height: { ideal: 480 } },
  });
  stream.getTracks().forEach(t => t.stop());
  await chrome.storage.local.set({ flowcast_permissions_granted: Date.now() });
}

function showPermissionOverlay() {
  const overlay = document.getElementById('permission-overlay');
  if (overlay) overlay.style.display = 'flex';

  const grantBtn = document.getElementById('grant-permission-btn');
  const permError = document.getElementById('permission-error');
  if (!grantBtn || grantBtn.dataset.bound) return;
  grantBtn.dataset.bound = 'true';

  grantBtn.addEventListener('click', async () => {
    grantBtn.disabled = true;
    if (permError) permError.style.display = 'none';

    try {
      await requestPermissionsInPopup();
      if (overlay) overlay.style.display = 'none';
      await initializePopup();
    } catch (err) {
      grantBtn.disabled = false;
      if (permError) {
        permError.style.display = 'block';
        permError.textContent = err.name === 'NotAllowedError'
          ? 'Permission denied. Allow access in the browser prompt and try again.'
          : err.message;
      }
    }
  });
}

// ── Init ───────────────────────────────────────────────────

async function initializePopup() {
  await checkCurrentState();
  await enumerateDevices();
  await loadSavedSettings();
  await verifyDevices();
  bindEvents();
}

document.addEventListener('DOMContentLoaded', async () => {
  if (await checkPermissionsGranted()) {
    await initializePopup();
  } else {
    showPermissionOverlay();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.flowcast_permissions_granted) return;
  const overlay = document.getElementById('permission-overlay');
  if (overlay?.style.display !== 'none') {
    overlay.style.display = 'none';
    initializePopup();
  }
});

async function checkCurrentState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response?.success && response.state?.status !== 'idle') {
      showRecordingActive();
    }
    const data = await chrome.storage.session.get('flowcast_error');
    if (data.flowcast_error) {
      showError(data.flowcast_error);
      await chrome.storage.session.remove('flowcast_error');
    }
  } catch (_) {}
}

// ── Device enumeration & verification ────────────────────────

async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const needsPrompt = !devices.some(
      d => (d.kind === 'audioinput' || d.kind === 'videoinput') && d.label !== ''
    );

    if (needsPrompt) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        s.getTracks().forEach(t => t.stop());
      } catch (_) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach(t => t.stop());
        } catch (__) {}
      }
    }

    const updated = await navigator.mediaDevices.enumerateDevices();

    const cameras = updated.filter(d => d.kind === 'videoinput');
    cameraSelect.innerHTML = cameras.length
      ? cameras.map((c, i) => `<option value="${c.deviceId}">${c.label || `Camera ${i + 1}`}</option>`).join('')
      : '<option value="">No camera</option>';

    const mics = updated.filter(d => d.kind === 'audioinput');
    micSelect.innerHTML = mics.length
      ? mics.map((m, i) => `<option value="${m.deviceId}">${m.label || `Mic ${i + 1}`}</option>`).join('')
      : '<option value="">No microphone</option>';
  } catch (err) {
    cameraSelect.innerHTML = '<option value="">Permission required</option>';
    micSelect.innerHTML = '<option value="">Permission required</option>';
  }
}

/** Quick check that selected devices work — updates green status chips. */
async function verifyDevices() {
  stopPreviewStream();

  const wantVideo = selectedMode !== 'screen';
  const camId = cameraSelect.value;
  const micId = micSelect.value;

  const constraints = {};
  if (wantVideo) {
    constraints.video = camId
      ? { deviceId: { ideal: camId }, width: { ideal: 320 }, height: { ideal: 240 } }
      : { width: { ideal: 320 }, height: { ideal: 240 } };
  }
  constraints.audio = micId
    ? { deviceId: { ideal: micId }, echoCancellation: true }
    : { echoCancellation: true };

  if (selectedMode === 'screen') delete constraints.video;

  let camOk = selectedMode === 'screen';
  let micOk = false;

  try {
    previewStream = await navigator.mediaDevices.getUserMedia(constraints);
    camOk = wantVideo ? previewStream.getVideoTracks().some(t => t.readyState === 'live') : true;
    micOk = previewStream.getAudioTracks().some(t => t.readyState === 'live');
  } catch (err) {
    // Try audio-only fallback
    if (wantVideo) {
      try {
        previewStream = await navigator.mediaDevices.getUserMedia({
          audio: constraints.audio,
        });
        micOk = previewStream.getAudioTracks().length > 0;
        camOk = false;
      } catch (_) {}
    }
  }

  deviceStatus.style.display = 'flex';
  setChip(camChip, camOk || selectedMode === 'screen');
  setChip(micChip, micOk);
}

function setChip(el, ok) {
  el.classList.toggle('ok', ok);
  el.classList.toggle('fail', !ok);
}

function stopPreviewStream() {
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
}

// ── Settings ───────────────────────────────────────────────

async function loadSavedSettings() {
  const { flowcast_settings: s } = await chrome.storage.local.get('flowcast_settings');
  if (!s) return;

  if (s.mode) {
    selectedMode = s.mode;
    modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === selectedMode));
    updateModeVisibility();
  }
  if (s.quality) {
    const radio = document.querySelector(`input[name="quality"][value="${s.quality}"]`);
    if (radio) radio.checked = true;
  }
  if (s.camId && cameraSelect.querySelector(`option[value="${s.camId}"]`)) {
    cameraSelect.value = s.camId;
  }
  if (s.micId && micSelect.querySelector(`option[value="${s.micId}"]`)) {
    micSelect.value = s.micId;
  }
}

async function saveSettings() {
  await chrome.storage.local.set({ flowcast_settings: getCurrentSettings() });
}

function getCurrentSettings() {
  const quality = document.querySelector('input[name="quality"]:checked')?.value || '1080p';
  return {
    mode: selectedMode,
    camId: cameraSelect.value || null,
    micId: micSelect.value || null,
    micEnabled: true,
    quality,
    camEnabled: selectedMode === 'screen-cam',
    screenEnabled: selectedMode === 'screen-cam' || selectedMode === 'screen',
  };
}

// ── Events ─────────────────────────────────────────────────

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  modeTabs.forEach(tab => {
    tab.addEventListener('click', async () => {
      modeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      selectedMode = tab.dataset.mode;
      updateModeVisibility();
      await saveSettings();
      await verifyDevices();
    });
  });

  cameraSelect.addEventListener('change', async () => {
    await saveSettings();
    await verifyDevices();
  });

  micSelect.addEventListener('change', async () => {
    await saveSettings();
    await verifyDevices();
  });

  document.querySelectorAll('input[name="quality"]').forEach(r => {
    r.addEventListener('change', saveSettings);
  });

  startBtn.addEventListener('click', handleStartRecording);
}

function updateModeVisibility() {
  cameraSection.style.display = selectedMode === 'screen' ? 'none' : 'flex';
  const hint = document.getElementById('start-hint');
  if (hint) {
    hint.textContent = selectedMode === 'cam'
      ? 'Recording starts with a countdown on the current page.'
      : 'A screen-share dialog will appear — pick your screen or tab.';
  }
}

async function handleStartRecording() {
  startBtn.disabled = true;
  errorBanner.style.display = 'none';

  const settings = getCurrentSettings();

  try {
    // Verify there is a recordable tab before proceeding
    const tabCheck = await chrome.runtime.sendMessage({ type: 'CHECK_RECORDABLE_TAB' });
    if (!tabCheck?.success) {
      showError(tabCheck?.error || 'No recordable tab found. Open a website first.');
      startBtn.disabled = false;
      return;
    }

    stopPreviewStream();
    await saveSettings();

    const response = await chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      settings,
    });

    if (response?.success) {
      showRecordingActive();
      // Keep popup open briefly so screen-share picker can appear
      setTimeout(() => window.close(), 1200);
    } else {
      showError(response?.error || 'Failed to start recording');
      startBtn.disabled = false;
      await verifyDevices();
    }
  } catch (err) {
    showError(err.message || 'Failed to start recording. Reload the extension.');
    startBtn.disabled = false;
    await verifyDevices();
  }
}

function showRecordingActive() {
  document.querySelectorAll('.section, .start-btn, .footer, .device-status, .start-hint').forEach(el => {
    el.style.display = 'none';
  });
  recordingView.style.display = 'flex';
}

function showError(message) {
  errorText.textContent = message;
  errorBanner.style.display = 'flex';
}

window.addEventListener('unload', stopPreviewStream);
