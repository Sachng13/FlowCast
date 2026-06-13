/**
 * FlowCast — Recorder Panel (Loom-style)
 *
 * Live camera preview + mic level meter before recording.
 * Permissions granted inline; devices verified before Start is enabled.
 */

// ── DOM ────────────────────────────────────────────────────

const permissionGate = document.getElementById('permission-gate');
const recorderMain   = document.getElementById('recorder-main');
const grantBtn       = document.getElementById('grant-btn');
const gateError      = document.getElementById('gate-error');

const cameraPreview  = document.getElementById('camera-preview');
const previewFrame   = document.getElementById('preview-frame');
const camStatus      = document.getElementById('cam-status');
const micStatus      = document.getElementById('mic-status');
const camLabel       = document.getElementById('cam-label');
const micLabel       = document.getElementById('mic-label');
const meterBars      = document.querySelectorAll('.meter-bar');
const meterHint      = document.getElementById('meter-hint');

const modeTabs       = document.querySelectorAll('.mode-tab');
const cameraSection  = document.getElementById('camera-section');
const cameraSelect   = document.getElementById('camera-select');
const micSelect      = document.getElementById('mic-select');
const startBtn       = document.getElementById('start-btn');
const errorBanner    = document.getElementById('error-banner');
const errorText      = document.getElementById('error-text');
const recordingActive = document.getElementById('recording-active');
const libraryLink    = document.getElementById('library-link');

// ── State ──────────────────────────────────────────────────

let selectedMode = 'screen-cam';
let previewStream = null;
let audioContext = null;
let analyser = null;
let meterAnimId = null;
let micLevelDetected = false;

let camReady = false;
let micReady = false;

// ── Boot ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  libraryLink.href = chrome.runtime.getURL('preview/preview.html');

  const granted = await hasMediaPermissions();
  if (granted) {
    showMainUI();
  } else {
    permissionGate.hidden = false;
    recorderMain.hidden = true;
  }

  grantBtn.addEventListener('click', handleGrantPermissions);
  await checkRecordingState();
});

async function hasMediaPermissions() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some(d =>
      (d.kind === 'audioinput' || d.kind === 'videoinput') && d.label !== ''
    );
  } catch (_) {
    return false;
  }
}

async function handleGrantPermissions() {
  grantBtn.disabled = true;
  gateError.hidden = true;

  try {
    // Always request both — browser will prompt user (Loom-style)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
      },
    });

    // Stop temp stream — preview will restart with selected devices
    stream.getTracks().forEach(t => t.stop());

    await chrome.storage.local.set({ flowcast_permissions_granted: Date.now() });
    showMainUI();
  } catch (err) {
    console.error('[FlowCast Recorder] Permission denied:', err);
    grantBtn.disabled = false;
    gateError.hidden = false;
    gateError.textContent = err.name === 'NotAllowedError'
      ? 'Access denied. Click the camera icon in your address bar to allow, then try again.'
      : `Could not access devices: ${err.message}`;
  }
}

async function showMainUI() {
  permissionGate.hidden = true;
  recorderMain.hidden = false;

  await populateDevices();
  await loadSettings();
  bindEvents();
  await startPreview();
  updateStartButton();
}

// ── Device enumeration ─────────────────────────────────────

async function populateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();

  const cameras = devices.filter(d => d.kind === 'videoinput');
  cameraSelect.innerHTML = cameras.length
    ? cameras.map((c, i) => `<option value="${c.deviceId}">${c.label || `Camera ${i + 1}`}</option>`).join('')
    : '<option value="">No camera</option>';

  const mics = devices.filter(d => d.kind === 'audioinput');
  micSelect.innerHTML = mics.length
    ? mics.map((m, i) => `<option value="${m.deviceId}">${m.label || `Microphone ${i + 1}`}</option>`).join('')
    : '<option value="">No microphone</option>';
}

// ── Live preview (camera + mic meter) ──────────────────────

async function startPreview() {
  stopPreview();

  const wantVideo = selectedMode !== 'screen';
  const camId = cameraSelect.value;
  const micId = micSelect.value;

  const constraints = {};

  if (wantVideo && camId) {
    constraints.video = {
      deviceId: { ideal: camId },
      width: { ideal: 640 },
      height: { ideal: 480 },
    };
  } else if (wantVideo) {
    constraints.video = { width: { ideal: 640 }, height: { ideal: 480 } };
  }

  if (micId) {
    constraints.audio = {
      deviceId: { ideal: micId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
  } else {
    constraints.audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
  }

  // Screen-only: audio only preview
  if (selectedMode === 'screen') {
    delete constraints.video;
  }

  try {
    previewStream = await navigator.mediaDevices.getUserMedia(constraints);

    const videoTrack = previewStream.getVideoTracks()[0];
    const audioTrack = previewStream.getAudioTracks()[0];

    camReady = !!videoTrack && videoTrack.readyState === 'live';
    micReady = !!audioTrack && audioTrack.readyState === 'live';

    if (videoTrack) {
      cameraPreview.srcObject = previewStream;
      previewFrame.classList.add('has-video');
      previewFrame.classList.remove('no-camera');
      camLabel.textContent = 'Camera connected';
      setStatus(camStatus, 'ok');
    } else {
      previewFrame.classList.remove('has-video');
      previewFrame.classList.add('no-camera');
      camReady = selectedMode === 'screen'; // not required for screen-only
      camLabel.textContent = selectedMode === 'screen' ? 'Camera off' : 'No camera';
      setStatus(camStatus, selectedMode === 'screen' ? 'warn' : 'error');
    }

    if (audioTrack) {
      micLabel.textContent = 'Microphone connected';
      setStatus(micStatus, 'ok');
      startAudioMeter(previewStream);
    } else {
      micReady = false;
      micLabel.textContent = 'No microphone';
      setStatus(micStatus, 'error');
    }

  } catch (err) {
    console.error('[FlowCast Recorder] Preview failed:', err);

    // Fallback: try audio-only
    if (wantVideo) {
      try {
        previewStream = await navigator.mediaDevices.getUserMedia({
          audio: constraints.audio || true,
        });
        const audioTrack = previewStream.getAudioTracks()[0];
        micReady = !!audioTrack;
        camReady = selectedMode !== 'cam';
        previewFrame.classList.remove('has-video');
        camLabel.textContent = 'Camera unavailable';
        setStatus(camStatus, 'error');
        if (audioTrack) {
          micLabel.textContent = 'Microphone connected';
          setStatus(micStatus, 'ok');
          startAudioMeter(previewStream);
        }
      } catch (audioErr) {
        camReady = false;
        micReady = false;
        setStatus(camStatus, 'error');
        setStatus(micStatus, 'error');
        camLabel.textContent = 'Camera failed';
        micLabel.textContent = 'Microphone failed';
      }
    }
  }

  updateStartButton();
}

function stopPreview() {
  if (meterAnimId) {
    cancelAnimationFrame(meterAnimId);
    meterAnimId = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
  cameraPreview.srcObject = null;
  previewFrame.classList.remove('has-video');
  micLevelDetected = false;
  meterBars.forEach(b => b.classList.remove('active', 'hot'));
  meterHint.textContent = 'Speak to test your mic';
  meterHint.classList.remove('active');
}

function startAudioMeter(stream) {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return;

  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.4;

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
    const avg = sum / data.length;
    const level = Math.min(1, avg / 80);

    meterBars.forEach((bar, i) => {
      const threshold = (i + 1) / meterBars.length;
      bar.classList.toggle('active', level >= threshold * 0.5);
      bar.classList.toggle('hot', level >= threshold * 0.85);
      bar.style.height = level >= threshold * 0.5
        ? `${4 + threshold * 22}px`
        : '4px';
    });

    if (level > 0.08) {
      micLevelDetected = true;
      micReady = true;
      meterHint.textContent = 'Mic is working!';
      meterHint.classList.add('active');
      setStatus(micStatus, 'ok');
      micLabel.textContent = 'Microphone working';
      updateStartButton();
    }

    meterAnimId = requestAnimationFrame(tick);
  }

  tick();
}

function setStatus(el, state) {
  el.classList.remove('ok', 'warn', 'error');
  if (state) el.classList.add(state);
}

// ── Settings ───────────────────────────────────────────────

async function loadSettings() {
  const { flowcast_settings: s } = await chrome.storage.local.get('flowcast_settings');
  if (!s) return;

  if (s.mode) {
    selectedMode = s.mode;
    modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === selectedMode));
    cameraSection.style.display = selectedMode === 'screen' ? 'none' : 'block';
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

function getSettings() {
  const quality = document.querySelector('input[name="quality"]:checked')?.value || '1080p';
  return {
    mode: selectedMode,
    camId: cameraSelect.value || null,
    micId: micSelect.value || null,
    micEnabled: true,
    quality,
    camEnabled: selectedMode === 'screen-cam',
    screenEnabled: selectedMode === 'screen-cam' || selectedMode === 'screen',
    // Pass verified device state so offscreen knows preview worked
    previewVerified: { camReady, micReady },
  };
}

async function saveSettings() {
  await chrome.storage.local.set({ flowcast_settings: getSettings() });
}

// ── Events ─────────────────────────────────────────────────

function bindEvents() {
  modeTabs.forEach(tab => {
    tab.addEventListener('click', async () => {
      modeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      selectedMode = tab.dataset.mode;
      cameraSection.style.display = selectedMode === 'screen' ? 'none' : 'block';
      document.getElementById('record-hint').innerHTML = selectedMode === 'screen' || selectedMode === 'screen-cam'
        ? 'When sharing your screen, enable <strong>"Share tab audio"</strong> in the browser dialog to capture system sound.'
        : 'Make sure your camera and mic indicators are green before recording.';
      await saveSettings();
      await startPreview();
    });
  });

  cameraSelect.addEventListener('change', async () => {
    await saveSettings();
    await startPreview();
  });

  micSelect.addEventListener('change', async () => {
    micLevelDetected = false;
    await saveSettings();
    await startPreview();
  });

  document.querySelectorAll('input[name="quality"]').forEach(r => {
    r.addEventListener('change', saveSettings);
  });

  startBtn.addEventListener('click', handleStartRecording);
}

function updateStartButton() {
  const canRecord = isReadyToRecord();
  startBtn.disabled = !canRecord;

  if (!canRecord) {
    if (!micReady && selectedMode !== 'cam') {
      startBtn.title = 'Waiting for microphone…';
    } else if (!camReady && selectedMode === 'cam') {
      startBtn.title = 'Waiting for camera…';
    } else if (!micReady && selectedMode === 'cam') {
      startBtn.title = 'Waiting for microphone…';
    }
  } else {
    startBtn.title = '';
  }
}

function isReadyToRecord() {
  if (selectedMode === 'screen') return micReady;
  if (selectedMode === 'cam') return camReady && micReady;
  return camReady && micReady; // screen-cam
}

async function handleStartRecording() {
  if (!isReadyToRecord()) return;

  startBtn.disabled = true;
  errorBanner.hidden = true;

  // Stop preview before recording — offscreen will acquire its own streams
  stopPreview();

  const settings = getSettings();
  await saveSettings();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      settings,
    });

    if (response?.success) {
      document.querySelectorAll('.section, .btn-record, .preview-section, .record-hint, .recorder-header')
        .forEach(el => { el.style.display = 'none'; });
      recordingActive.hidden = false;
    } else {
      showError(response?.error || 'Failed to start recording');
      startBtn.disabled = false;
      await startPreview();
    }
  } catch (err) {
    showError('Could not start recording. Reload the extension and try again.');
    startBtn.disabled = false;
    await startPreview();
  }
}

async function checkRecordingState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response?.success && response.state?.status !== 'idle') {
      permissionGate.hidden = true;
      recorderMain.hidden = false;
      document.querySelectorAll('.section, .btn-record, .preview-section, .record-hint, .recorder-header, #permission-gate')
        .forEach(el => { if (el) el.style.display = 'none'; });
      recordingActive.hidden = false;
    }

    const { flowcast_error: err } = await chrome.storage.session.get('flowcast_error');
    if (err) {
      showError(err);
      await chrome.storage.session.remove('flowcast_error');
    }
  } catch (_) {}
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.hidden = false;
}

// Cleanup when panel closes
window.addEventListener('pagehide', stopPreview);
