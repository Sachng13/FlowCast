/**
 * FlowCast — Permissions Setup Page
 * Dedicated page for granting mic/camera access.
 * Does NOT redirect to the library — instructs user to reopen the extension popup.
 */

const grantBtn = document.getElementById('grant-btn');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');

function showStatus(type, message) {
  statusEl.className = `status ${type}`;
  statusEl.textContent = message;
  statusEl.style.display = 'block';
}

async function requestPermissions() {
  grantBtn.disabled = true;
  showStatus('info', 'Requesting permissions…');

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasCamera = devices.some(d => d.kind === 'videoinput');

    const constraints = { audio: true };
    if (hasCamera) {
      constraints.video = true;
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach(t => t.stop());

    await chrome.storage.local.set({
      flowcast_permissions_granted: Date.now(),
    });

    grantBtn.style.display = 'none';
    hintEl.style.display = 'none';

    showStatus(
      'success',
      'Permissions granted! Click the FlowCast icon in your browser toolbar to start recording.'
    );

    // Attempt to close this tab — may fail for user-opened tabs, which is fine
    setTimeout(() => {
      window.close();
    }, 2500);
  } catch (err) {
    console.error('[FlowCast Permissions] Grant failed:', err);
    grantBtn.disabled = false;
    showStatus(
      'error',
      err.name === 'NotAllowedError'
        ? 'Permission denied. Please allow access in the browser prompt and try again.'
        : `Failed to get permissions: ${err.message}`
    );
  }
}

grantBtn.addEventListener('click', requestPermissions);

// If permissions were already granted, show success immediately
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasLabels = devices.some(
      d => (d.kind === 'audioinput' || d.kind === 'videoinput') && d.label !== ''
    );
    if (hasLabels) {
      grantBtn.style.display = 'none';
      showStatus(
        'success',
        'Permissions already granted! Click the FlowCast icon in your toolbar to start recording.'
      );
    }
  } catch (_) {}
});
