/**
 * FlowCast — Preview Dashboard Logic
 * 
 * Manages both the My Recordings library dashboard and the interactive 
 * post-recording preview player with synchronized transcript search & seeking.
 */

// ============================================================
//  DOM REFERENCES
// ============================================================

// View containers
const dashboardView = document.getElementById('dashboard-view');
const previewView   = document.getElementById('preview-view');
const emptyState    = document.getElementById('empty-state');
const recordingsGrid = document.getElementById('recordings-grid');

// Header elements
const logoBtn = document.getElementById('logo-btn');
const navDashboardBtn = document.getElementById('nav-dashboard-btn');
const backToLibraryBtn = document.getElementById('back-to-library-btn');

// Video preview elements
const titleInput  = document.getElementById('video-title');
const videoDate   = document.getElementById('video-date');
const videoPlayer = document.getElementById('video-player');

// Action buttons
const downloadBtn = document.getElementById('download-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const deleteBtn   = document.getElementById('delete-btn');
const copyTranscriptBtn = document.getElementById('copy-notes-btn');

// Metadata chips
const metaDuration = document.getElementById('meta-duration');
const metaFormat   = document.getElementById('meta-format');
const metaRes      = document.getElementById('meta-res');
const metaSize     = document.getElementById('meta-size');

// Video control elements
const playPauseBtn = document.getElementById('play-pause-btn');
const rewindBtn    = document.getElementById('rewind-btn');
const forwardBtn   = document.getElementById('forward-btn');
const timeCurrent  = document.getElementById('time-current');
const timeDuration = document.getElementById('time-duration');
const volumeBtn    = document.getElementById('volume-btn');
const volumeSlider = document.getElementById('volume-slider');
const speedBtn     = document.getElementById('speed-btn');
const speedMenu    = document.getElementById('speed-menu');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const progressContainer = document.getElementById('progress-container');
const progressFill   = document.getElementById('progress-fill');
const progressBuffer = document.getElementById('progress-buffer');

// Notes elements
const notesContainer      = document.getElementById('notes-container');
const noteTextInput       = document.getElementById('note-text-input');
const addNoteBtn          = document.getElementById('add-note-btn');
const noNotesPlaceholder  = document.getElementById('no-notes-placeholder');

// Toast
const toast = document.getElementById('toast-notification');
const toastMessage = document.getElementById('toast-message');

// ============================================================
//  STATE
// ============================================================

let currentRecording = null;
let isScrubbing = false;
let noteSegments = []; // Cache segment elements for filtering and synchronization

// ============================================================
//  INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initPage();
  bindEvents();
});

function initPage() {
  const params = new URLSearchParams(window.location.search);
  const setup = params.get('setup');
  const recordingId = params.get('id');

  if (setup === 'true') {
    window.location.replace(chrome.runtime.getURL('permissions/permissions.html'));
    return;
  }

  if (recordingId) {
    loadSingleRecording(recordingId);
  } else {
    loadDashboard();
  }
}

// ============================================================
//  DASHBOARD (LIBRARY) VIEW
// ============================================================

async function loadDashboard() {
  // Update browser URL (clean up parameters)
  window.history.pushState({}, '', window.location.pathname);

  // Switch views
  previewView.style.display = 'none';
  dashboardView.style.display = 'block';

  recordingsGrid.innerHTML = '';
  emptyState.style.display = 'none';

  try {
    const recordings = await FlowCastDB.getAllRecordings();

    if (recordings.length === 0) {
      emptyState.style.display = 'flex';
      return;
    }

    recordings.forEach(rec => {
      const card = createRecordingCard(rec);
      recordingsGrid.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load recordings library:', err);
    showToast('Failed to load library database.');
  }
}

function createRecordingCard(rec) {
  const card = document.createElement('div');
  card.className = 'rec-card';
  card.dataset.id = rec.id;

  // Title fallback
  const title = rec.title || 'Untitled Recording';
  const dateStr = new Date(rec.timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  
  const formattedDur = formatSeconds(Math.round(rec.duration / 1000));
  const fileSizeMB = (rec.size / (1024 * 1024)).toFixed(1);
  const quality = rec.settings?.quality ? rec.settings.quality.toUpperCase() : '1080P';

  card.innerHTML = `
    <div class="card-thumbnail">
      <!-- Short preview video (muted, autoplay-on-hover) -->
      <video src="${URL.createObjectURL(rec.blob)}" muted playsinline></video>
      <div class="card-play-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21"/>
        </svg>
      </div>
      <span class="card-duration">${formattedDur}</span>
    </div>
    <div class="card-info">
      <h3 class="card-title">${title}</h3>
      <div class="card-meta">
        <span>${dateStr}</span>
        <span class="card-badge">${quality}</span>
      </div>
      <div class="rec-card-details">
        <span>${fileSizeMB} MB</span>
        <button class="rec-card-delete" title="Delete Recording" data-id="${rec.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </div>
  `;

  // Autoplay short clip on hover
  const video = card.querySelector('video');
  card.addEventListener('mouseenter', () => {
    video.currentTime = 0;
    video.play().catch(() => {});
  });
  card.addEventListener('mouseleave', () => {
    video.pause();
  });

  // Navigate to player on click
  card.addEventListener('click', (e) => {
    // Avoid triggering navigation when delete icon is clicked
    if (e.target.closest('.rec-card-delete')) return;
    openRecording(rec.id);
  });

  // Delete card button action
  const cardDeleteBtn = card.querySelector('.rec-card-delete');
  cardDeleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this recording?')) {
      try {
        await FlowCastDB.deleteRecording(rec.id);
        showToast('Recording deleted.');
        loadDashboard();
      } catch (err) {
        console.error('Delete failed:', err);
      }
    }
  });

  return card;
}

function openRecording(id) {
  // Push state to URL to support browser back button / direct link
  window.history.pushState({}, '', `?id=${id}`);
  loadSingleRecording(id);
}

// ============================================================
//  SINGLE VIDEO PREVIEW VIEW
// ============================================================

async function loadSingleRecording(id) {
  try {
    const rec = await FlowCastDB.getRecording(id);

    if (!rec) {
      alert('Recording not found.');
      loadDashboard();
      return;
    }

    currentRecording = rec;

    // Switch views
    dashboardView.style.display = 'none';
    previewView.style.display = 'block';

    // Populate titles & date
    titleInput.value = rec.title || 'Untitled Recording';
    const date = new Date(rec.timestamp);
    videoDate.textContent = date.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    // Load video player source
    const videoUrl = URL.createObjectURL(rec.blob);
    videoPlayer.src = videoUrl;
    videoPlayer.load();

    // Populate metadata chips
    const formattedDur = formatDuration(rec.duration);
    metaDuration.textContent = formattedDur;
    metaFormat.textContent = rec.mimeType.split(';')[0].split('/')[1] || 'webm';
    metaRes.textContent = rec.settings?.quality ? rec.settings.quality.toUpperCase() : '1080P';
    metaSize.textContent = `${(rec.size / (1024 * 1024)).toFixed(1)} MB`;

    // Populate Interactive Notes
    renderNotes(rec.notes || []);

    // Reset player controls state
    videoPlayer.playbackRate = 1.0;
    speedBtn.textContent = '1.0x';
    document.querySelectorAll('.speed-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.speed === '1.0');
    });

  } catch (err) {
    console.error('Failed to load recording details:', err);
    showToast('Failed to retrieve recording from database.');
    loadDashboard();
  }
}

// ============================================================
//  INTERACTIVE VIDEO NOTES GENERATION & MANAGEMENT
// ============================================================

function renderNotes(notes) {
  notesContainer.innerHTML = '';
  noNotesPlaceholder.style.display = 'none';
  noteSegments = [];

  if (!notes || notes.length === 0) {
    noNotesPlaceholder.style.display = 'block';
    return;
  }

  // Sort notes by timestamp ascending
  const sortedNotes = [...notes].sort((a, b) => a.timestamp - b.timestamp);

  sortedNotes.forEach((note, index) => {
    const noteEl = document.createElement('div');
    noteEl.className = 'transcript-segment'; // reuse CSS styling
    noteEl.dataset.time = note.timestamp;

    const stamp = formatSeconds(Math.round(note.timestamp / 1000));

    noteEl.innerHTML = `
      <div class="segment-meta">
        <span class="segment-time" style="cursor: pointer;">${stamp}</span>
        <button class="note-delete-btn" title="Delete note" data-index="${index}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
      <p class="segment-text" style="word-break: break-word;">${escapeHtml(note.text)}</p>
    `;

    // Clicking segment seeks the video player
    noteEl.querySelector('.segment-time').addEventListener('click', (e) => {
      e.stopPropagation();
      const timeInSecs = note.timestamp / 1000;
      videoPlayer.currentTime = timeInSecs;
      videoPlayer.play().catch(() => {});
    });

    noteEl.addEventListener('click', () => {
      const timeInSecs = note.timestamp / 1000;
      videoPlayer.currentTime = timeInSecs;
    });

    // Delete note
    noteEl.querySelector('.note-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Are you sure you want to delete this note?')) {
        currentRecording.notes.splice(index, 1);
        try {
          await FlowCastDB.saveRecording(currentRecording);
          renderNotes(currentRecording.notes);
          showToast('Note deleted.');
        } catch (err) {
          console.error('Failed to delete note:', err);
        }
      }
    });

    notesContainer.appendChild(noteEl);
    noteSegments.push({
      el: noteEl,
      time: note.timestamp,
      text: note.text.toLowerCase()
    });
  });
}

async function addNote() {
  if (!currentRecording) return;
  const text = noteTextInput.value.trim();
  if (!text) return;

  const currentTimeMs = videoPlayer.currentTime * 1000;
  if (!currentRecording.notes) {
    currentRecording.notes = [];
  }

  currentRecording.notes.push({
    timestamp: currentTimeMs,
    text: text
  });

  // Sort notes by timestamp ascending
  currentRecording.notes.sort((a, b) => a.timestamp - b.timestamp);

  try {
    await FlowCastDB.saveRecording(currentRecording);
    noteTextInput.value = '';
    renderNotes(currentRecording.notes);
    showToast('Note added!');
  } catch (err) {
    console.error('Failed to save note:', err);
    showToast('Failed to save note.');
  }
}

function updateNotesActive(timeMs) {
  let activeIndex = -1;

  // Find the note that covers current time
  for (let i = 0; i < noteSegments.length; i++) {
    const nextSeg = noteSegments[i + 1];
    const isLast = i === noteSegments.length - 1;

    if (timeMs >= noteSegments[i].time && (isLast || timeMs < nextSeg.time)) {
      activeIndex = i;
      break;
    }
  }

  // Handle visual classes
  noteSegments.forEach((seg, i) => {
    const isActive = i === activeIndex;
    seg.el.classList.toggle('active', isActive);

    // Auto-scroll inside container
    if (isActive) {
      if (seg.el.dataset.scrolled !== 'true') {
        noteSegments.forEach(s => s.el.removeAttribute('data-scrolled'));
        seg.el.dataset.scrolled = 'true';
        
        seg.el.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest'
        });
      }
    }
  });
}

// ============================================================
//  CUSTOM VIDEO PLAYER EVENT BINDING
// ============================================================

function setupPlayerControls() {
  // Play / Pause Toggle
  const togglePlay = () => {
    if (videoPlayer.paused) {
      videoPlayer.play();
    } else {
      videoPlayer.pause();
    }
  };

  playPauseBtn.addEventListener('click', togglePlay);
  videoPlayer.addEventListener('click', togglePlay);

  videoPlayer.addEventListener('play', () => {
    playPauseBtn.querySelector('.play-icon').style.display = 'none';
    playPauseBtn.querySelector('.pause-icon').style.display = 'block';
  });

  videoPlayer.addEventListener('pause', () => {
    playPauseBtn.querySelector('.play-icon').style.display = 'block';
    playPauseBtn.querySelector('.pause-icon').style.display = 'none';
  });

  // Rewind / Forward (10 seconds)
  rewindBtn.addEventListener('click', () => {
    videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 10);
  });

  forwardBtn.addEventListener('click', () => {
    let dur = videoPlayer.duration;
    if ((isNaN(dur) || !isFinite(dur)) && currentRecording) {
      dur = currentRecording.duration / 1000;
    }
    videoPlayer.currentTime = Math.min(dur || 0, videoPlayer.currentTime + 10);
  });

  // Volume Scrubber
  volumeSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    videoPlayer.volume = val;
    videoPlayer.muted = (val === 0);
    updateVolumeIcon();
    updateVolumeFill();
  });

  volumeBtn.addEventListener('click', () => {
    videoPlayer.muted = !videoPlayer.muted;
    updateVolumeIcon();
    updateVolumeFill();
  });

  // Time Updates (timeline progress)
  videoPlayer.addEventListener('timeupdate', () => {
    if (isScrubbing) return;
    
    const cur = videoPlayer.currentTime;
    let dur = videoPlayer.duration;
    if ((isNaN(dur) || !isFinite(dur)) && currentRecording) {
      dur = currentRecording.duration / 1000;
    }

    // Time text display
    timeCurrent.textContent = formatSeconds(Math.round(cur));
    if (dur && isFinite(dur)) {
      timeDuration.textContent = formatSeconds(Math.round(dur));
    }

    // Timeline fill
    const pct = (dur && isFinite(dur)) ? (cur / dur) * 100 : 0;
    progressFill.style.width = pct + '%';

    // Synchronize notes active state
    updateNotesActive(cur * 1000);
  });

  // Buffered Progress
  videoPlayer.addEventListener('progress', () => {
    let dur = videoPlayer.duration;
    if ((isNaN(dur) || !isFinite(dur)) && currentRecording) {
      dur = currentRecording.duration / 1000;
    }
    if (dur > 0 && isFinite(dur) && videoPlayer.buffered.length > 0) {
      const bufferedEnd = videoPlayer.buffered.end(videoPlayer.buffered.length - 1);
      const pct = (bufferedEnd / dur) * 100;
      progressBuffer.style.width = pct + '%';
    }
  });

  videoPlayer.addEventListener('loadedmetadata', () => {
    let dur = videoPlayer.duration;
    if ((isNaN(dur) || !isFinite(dur)) && currentRecording) {
      dur = currentRecording.duration / 1000;
    }
    if (dur && isFinite(dur)) {
      timeDuration.textContent = formatSeconds(Math.round(dur));
    }
    updateVolumeFill();
  });

  // Speed Control Menu toggling
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const showing = speedMenu.style.display === 'flex';
    speedMenu.style.display = showing ? 'none' : 'flex';
  });

  document.addEventListener('click', () => {
    speedMenu.style.display = 'none';
  });

  document.querySelectorAll('.speed-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const rate = parseFloat(opt.dataset.speed);
      videoPlayer.playbackRate = rate;
      speedBtn.textContent = rate === 1.0 ? '1.0x' : rate + 'x';
      
      document.querySelectorAll('.speed-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
    });
  });

  // Fullscreen
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      videoPlayer.requestFullscreen().catch((err) => {
        console.warn(`Fullscreen error: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  });

  // Scrubber dragging logic
  const seek = (e) => {
    const rect = progressContainer.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    progressFill.style.width = (pct * 100) + '%';
    
    let dur = videoPlayer.duration;
    if ((isNaN(dur) || !isFinite(dur)) && currentRecording) {
      dur = currentRecording.duration / 1000;
    }
    if (dur && isFinite(dur)) {
      videoPlayer.currentTime = pct * dur;
    }
  };

  progressContainer.addEventListener('mousedown', (e) => {
    isScrubbing = true;
    seek(e);
  });

  document.addEventListener('mousemove', (e) => {
    if (isScrubbing) seek(e);
  });

  document.addEventListener('mouseup', () => {
    isScrubbing = false;
  });
}

function updateVolumeIcon() {
  const isMute = videoPlayer.muted || videoPlayer.volume === 0;
  volumeBtn.querySelector('.volume-high').style.display = isMute ? 'none' : 'block';
  volumeBtn.querySelector('.volume-mute').style.display = isMute ? 'block' : 'none';
  if (isMute) {
    volumeSlider.value = 0;
  } else {
    volumeSlider.value = videoPlayer.volume;
  }
}

function updateVolumeFill() {
  const value = parseFloat(volumeSlider.value) || 0;
  const pct = Math.max(0, Math.min(100, value * 100));
  volumeSlider.style.background = `linear-gradient(90deg, var(--primary) ${pct}%, rgba(255, 255, 255, 0.2) ${pct}%)`;
}

// ============================================================
//  EVENT BINDINGS & USER INTERACTIONS
// ============================================================

function bindEvents() {
  // Setup player controls handlers
  setupPlayerControls();

  // Logo & Dashboard navigation clicks
  logoBtn.addEventListener('click', loadDashboard);
  navDashboardBtn.addEventListener('click', loadDashboard);
  backToLibraryBtn.addEventListener('click', loadDashboard);

  // Add Note listeners
  addNoteBtn.addEventListener('click', addNote);
  noteTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addNote();
    }
  });

  // Rename Recording (Persist Title on Blur or Enter Key)
  titleInput.addEventListener('blur', saveVideoTitle);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      titleInput.blur(); // Triggers save on blur
    }
  });

  // Download video Blob
  downloadBtn.addEventListener('click', () => {
    if (!currentRecording) return;
    const title = currentRecording.title || 'Untitled Recording';
    const a = document.createElement('a');
    a.href = videoPlayer.src;
    a.download = `${title.toLowerCase().replace(/\s+/g, '_')}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Download started!');
  });

  // Copy simulated Cloud link
  copyLinkBtn.addEventListener('click', () => {
    if (!currentRecording) return;
    const shareUrl = window.location.href;
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast('Shareable viewer link copied to clipboard!');
    }).catch(() => {
      showToast('Failed to copy link.');
    });
  });

  // Copy full notes to clipboard
  copyTranscriptBtn.addEventListener('click', () => {
    if (!currentRecording?.notes || currentRecording.notes.length === 0) return;
    
    const plainText = currentRecording.notes
      .map(note => `[${formatSeconds(Math.round(note.timestamp / 1000))}] ${note.text}`)
      .join('\n');

    navigator.clipboard.writeText(plainText).then(() => {
      showToast('Full notes copied to clipboard!');
    }).catch(() => {
      showToast('Failed to copy notes.');
    });
  });

  // Delete recording from single view
  deleteBtn.addEventListener('click', async () => {
    if (!currentRecording) return;
    if (confirm('Are you sure you want to delete this recording permanently?')) {
      try {
        await FlowCastDB.deleteRecording(currentRecording.id);
        showToast('Recording deleted.');
        loadDashboard();
      } catch (err) {
        console.error('Delete failed:', err);
      }
    }
  });
}

/**
 * Persists the edited recording title to IndexedDB.
 */
async function saveVideoTitle() {
  if (!currentRecording) return;
  const newTitle = titleInput.value.trim() || 'Untitled Recording';
  
  if (newTitle !== currentRecording.title) {
    currentRecording.title = newTitle;
    try {
      await FlowCastDB.saveRecording(currentRecording);
      showToast('Title updated!');
    } catch (err) {
      console.error('Failed to save title update:', err);
    }
  }
}

// ============================================================
//  FORMATTING UTILITIES
// ============================================================

function formatDuration(ms) {
  const secs = Math.round(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  if (mins === 0) {
    return `${remainingSecs}s`;
  }
  return `${mins}m ${remainingSecs}s`;
}

function formatSeconds(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60).toString();
  const secs = (totalSeconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function showToast(message) {
  toastMessage.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}
