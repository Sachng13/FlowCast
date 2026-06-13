/**
 * FlowCast — Popup Logic
 * Small extension popup with Loom-style live preview + mic meter.
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
const previewPanel   = document.getElementById('preview-panel');
const previewBubble  = document.getElementById('preview-bubble-wrap');
const previewVideo   = document.getElementById('preview-video');
const previewPlaceholder = document.getElementById('preview-placeholder');
const previewLiveBadge = document.getElementById('preview-live-badge');
const meterStatus    = document.getElementById('meter-status');
const meterBars      = document.querySelectorAll('.meter-bar');

let selectedMode = 'screen-cam';
let eventsBound = false;
let previewStream = null;
let audioContext = null;
let analyser = null;
let meterAnimId = null;

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
  updatePreviewVisibility();
  await startLivePreview();
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

// ── Device enumeration ─────────────────────────────────────

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

// ── Live preview + audio meter (Loom-style) ───────────────

function updatePreviewVisibility() {
  const showCam = selectedMode !== 'screen';
  if (previewBubble) {
    previewBubble.style.display = showCam ? 'flex' : 'none';
  }
  previewPanel?.classList.toggle('screen-only', selectedMode === 'screen');
}

async function startLivePreview() {
  stopPreviewStream();
  resetMeter();

  const wantVideo = selectedMode !== 'screen';
  const camId = cameraSelect.value;
  const micId = micSelect.value;

  const constraints = {};
  if (wantVideo) {
    constraints.video = camId
      ? { deviceId: { ideal: camId }, width: { ideal: 480 }, height: { ideal: 360 } }
      : { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: 'user' };
  }
  constraints.audio = micId
    ? { deviceId: { ideal: micId }, echoCancellation: true, noiseSuppression: true }
    : { echoCancellation: true, noiseSuppression: true };

  let camOk = !wantVideo;
  let micOk = false;

  try {
    previewStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (wantVideo) {
      try {
        previewStream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio });
      } catch (_) {}
    }
  }

  if (previewStream) {
    const videoTrack = previewStream.getVideoTracks()[0];
    const audioTrack = previewStream.getAudioTracks()[0];

    camOk = wantVideo && videoTrack && videoTrack.readyState === 'live';
    micOk = audioTrack && audioTrack.readyState === 'live';

    if (camOk && previewVideo) {
      previewVideo.srcObject = previewStream;
      previewBubble?.classList.add('has-video');
      previewLiveBadge?.classList.add('active');
    } else {
      previewBubble?.classList.remove('has-video');
      previewLiveBadge?.classList.remove('active');
    }

    if (micOk) {
      startAudioMeter(previewStream);
    }
  }

  deviceStatus.style.display = 'flex';
  setChip(camChip, camOk || selectedMode === 'screen');
  setChip(micChip, micOk);
}

function startAudioMeter(stream) {
  stopAudioMeter();

  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.45;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const level = Math.min(1, sum / data.length / 75);

    meterBars.forEach((bar, i) => {
      const threshold = (i + 1) / meterBars.length;
      const active = level >= threshold * 0.45;
      const hot = level >= threshold * 0.8;
      bar.classList.toggle('active', active);
      bar.classList.toggle('hot', hot);
      bar.style.height = active ? `${5 + threshold * 18}px` : '4px';
    });

    if (level > 0.06) {
      meterStatus.textContent = 'Mic working';
      meterStatus.classList.add('ok');
      setChip(micChip, true);
    }

    meterAnimId = requestAnimationFrame(tick);
  }

  tick();
}

function stopAudioMeter() {
  if (meterAnimId) {
    cancelAnimationFrame(meterAnimId);
    meterAnimId = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }
  resetMeter();
}

function resetMeter() {
  meterBars.forEach(bar => {
    bar.classList.remove('active', 'hot');
    bar.style.height = '4px';
  });
  if (meterStatus) {
    meterStatus.textContent = 'Speak to test';
    meterStatus.classList.remove('ok');
  }
}

function setChip(el, ok) {
  el.classList.toggle('ok', ok);
  el.classList.toggle('fail', !ok);
}

function stopPreviewStream() {
  stopAudioMeter();
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
  if (previewVideo) previewVideo.srcObject = null;
  previewBubble?.classList.remove('has-video');
  previewLiveBadge?.classList.remove('active');
}

// ── Settings ───────────────────────────────────────────────

async function loadSavedSettings() {
  const { flowcast_settings: s } = await chrome.storage.local.get('flowcast_settings');
  if (!s) return;

  if (s.mode) {
    selectedMode = ['screen-cam', 'screen'].includes(s.mode) ? s.mode : 'screen-cam';
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
      updatePreviewVisibility();
      await saveSettings();
      await startLivePreview();
    });
  });

  cameraSelect.addEventListener('change', async () => {
    await saveSettings();
    await startLivePreview();
  });

  micSelect.addEventListener('change', async () => {
    await saveSettings();
    await startLivePreview();
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
    hint.textContent = 'A screen-share dialog will appear — pick your screen or tab.';
  }
}

async function handleStartRecording() {
  startBtn.disabled = true;
  errorBanner.style.display = 'none';

  try {
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
      settings: getCurrentSettings(),
    });

    if (response?.success) {
      showRecordingActive();
      setTimeout(() => window.close(), 1200);
    } else {
      showError(response?.error || 'Failed to start recording');
      startBtn.disabled = false;
      await startLivePreview();
    }
  } catch (err) {
    showError(err.message || 'Failed to start recording. Reload the extension.');
    startBtn.disabled = false;
    await startLivePreview();
  }
}

function showRecordingActive() {
  document.querySelectorAll('.section, .start-btn, .footer, .device-status, .start-hint, .preview-panel').forEach(el => {
    el.style.display = 'none';
  });
  recordingView.style.display = 'flex';
}

function showError(message) {
  errorText.textContent = message;
  errorBanner.style.display = 'flex';
}

window.addEventListener('unload', stopPreviewStream);
