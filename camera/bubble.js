/**
 * Camera bubble iframe — runs on extension origin so popup-granted
 * camera permissions apply (unlike getUserMedia on the host page).
 */

const video = document.getElementById('video');
const params = new URLSearchParams(window.location.search);
const cameraId = params.get('camId');
let stream = null;

async function startCamera() {
  const videoConstraints = {
    width: { ideal: 640 },
    height: { ideal: 480 },
    facingMode: 'user',
  };

  if (cameraId) {
    videoConstraints.deviceId = { ideal: cameraId };
  }

  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
    } catch (err) {
      // Retry without specific device ID
      delete videoConstraints.deviceId;
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
    }

    video.srcObject = stream;
    window.parent.postMessage({ type: 'FLOWCAST_CAM_READY' }, '*');
  } catch (err) {
    console.error('[FlowCast Camera] Failed:', err);
    document.body.classList.add('error');
    document.body.innerHTML = '👤';
    window.parent.postMessage({ type: 'FLOWCAST_CAM_ERROR', error: err.message }, '*');
  }
}

window.addEventListener('beforeunload', () => {
  if (stream) stream.getTracks().forEach(t => t.stop());
});

startCamera();
