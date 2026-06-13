/**
 * FlowCast — Content Script
 * 
 * Injected into the active tab to render recording UI elements
 * directly on the page. All elements are visible to getDisplayMedia
 * because they are part of the rendered page.
 * 
 * Components:
 *   1. CountdownOverlay — 3-2-1 countdown before recording starts
 *   2. CameraBubble    — Circular draggable webcam preview
 *   3. ControlBar      — Floating bottom toolbar (stop, pause, mute, draw, timer)
 *   4. AnnotationCanvas — Full-page canvas for fading drawings & spotlight
 * 
 * Architecture:
 *   All classes are encapsulated in an IIFE to prevent global scope pollution.
 *   The FlowCastController class orchestrates all components and handles
 *   message passing with the Service Worker.
 */

(function () {
  'use strict';

  // ── Guard: prevent double injection ────────────────────
  if (window.__flowcast_injected) return;
  window.__flowcast_injected = true;

  // ============================================================
  //  SVG ICON CONSTANTS
  // ============================================================

  const ICONS = {
    stop: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    resume: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>',
    mic: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0014 0v-1"/><line x1="12" y1="18" x2="12" y2="23"/></svg>',
    micOff: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0014 0v-1"/><line x1="12" y1="18" x2="12" y2="23"/><line x1="1" y1="1" x2="23" y2="23" stroke="#ef4444" stroke-width="2.5"/></svg>',
    draw: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>',
    spotlight: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="4 3"/></svg>',
    camOn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    camOff: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/><line x1="1" y1="1" x2="23" y2="23" stroke="#ef4444" stroke-width="2.5"/></svg>',
    clear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
    emoji: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  };

  // ============================================================
  //  1. COUNTDOWN OVERLAY
  // ============================================================

  class CountdownOverlay {
    constructor() {
      this.el = null;
      this.numberEl = null;
    }

    /**
     * Show a 3-2-1 countdown. Returns a Promise that resolves when done.
     */
    show() {
      return new Promise((resolve) => {
        this.el = document.createElement('div');
        this.el.className = 'flowcast-countdown-overlay';

        this.numberEl = document.createElement('div');
        this.numberEl.className = 'flowcast-countdown-number';
        this.el.appendChild(this.numberEl);
        document.body.appendChild(this.el);

        let count = 3;
        this.numberEl.textContent = count;

        const interval = setInterval(() => {
          count--;
          if (count > 0) {
            // Re-trigger the pop animation by removing and re-adding the element
            const fresh = document.createElement('div');
            fresh.className = 'flowcast-countdown-number';
            fresh.textContent = count;
            this.el.replaceChild(fresh, this.numberEl);
            this.numberEl = fresh;
          } else {
            clearInterval(interval);
            this.remove();
            resolve();
          }
        }, 900);
      });
    }

    remove() {
      if (this.el) {
        this.el.style.opacity = '0';
        setTimeout(() => this.el?.remove(), 300);
      }
    }
  }

  // ============================================================
  //  2. CAMERA BUBBLE
  // ============================================================

  class CameraBubble {
    constructor() {
      this.el = null;
      this.videoEl = null;
      this.stream = null;
      this.isDragging = false;
      this.dragOffset = { x: 0, y: 0 };
      this.size = 'md'; // sm | md | lg
      this.audioAnalyser = null;
      this.audioAnimFrame = null;
      this.visible = true;
    }

    async init(cameraId) {
      // Create the bubble container
      this.el = document.createElement('div');
      this.el.className = 'flowcast-camera-bubble';

      // Create the video element
      this.videoEl = document.createElement('video');
      this.videoEl.className = 'flowcast-camera-video';
      this.videoEl.autoplay = true;
      this.videoEl.muted = true;
      this.videoEl.playsInline = true;
      this.el.appendChild(this.videoEl);

      document.body.appendChild(this.el);

      // Start camera stream
      try {
        const constraints = {
          video: cameraId ? { deviceId: { exact: cameraId } } : true,
          audio: false, // Do not request audio in content script to avoid unnecessary mic prompts on host pages
        };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.videoEl.srcObject = this.stream;

      } catch (err) {
        console.warn('[FlowCast] Camera access failed:', err);
        // Show a fallback avatar instead
        this.el.style.background = 'linear-gradient(135deg, #1e1b4b, #312e81)';
        this.el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:48px;color:#6366f1;">👤</div>';
      }

      // Bind drag events
      this.bindDrag();

      // Double-click to cycle size
      this.el.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.cycleSize();
      });
    }

    // Audio monitor removed to prevent mic permission prompt on host page

    bindDrag() {
      this.el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Left click only
        this.isDragging = true;
        const rect = this.el.getBoundingClientRect();
        this.dragOffset.x = e.clientX - rect.left;
        this.dragOffset.y = e.clientY - rect.top;
        this.el.style.transition = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!this.isDragging) return;
        const x = e.clientX - this.dragOffset.x;
        const y = e.clientY - this.dragOffset.y;

        // Constrain to viewport
        const maxX = window.innerWidth - this.el.offsetWidth;
        const maxY = window.innerHeight - this.el.offsetHeight;

        this.el.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
        this.el.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
        this.el.style.right = 'auto';
        this.el.style.bottom = 'auto';
      });

      document.addEventListener('mouseup', () => {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.el.style.transition = '';
        this.snapToEdge();
      });
    }

    snapToEdge() {
      const rect = this.el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const margin = 16;

      // Snap to left or right edge with smooth animation
      this.el.style.transition = 'left 0.3s cubic-bezier(0.16, 1, 0.3, 1), right 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
      if (centerX < window.innerWidth / 2) {
        this.el.style.left = margin + 'px';
      } else {
        this.el.style.left = (window.innerWidth - rect.width - margin) + 'px';
      }
    }

    cycleSize() {
      const sizes = ['sm', 'md', 'lg'];
      const currentIndex = sizes.indexOf(this.size);
      this.size = sizes[(currentIndex + 1) % sizes.length];

      this.el.classList.remove('flowcast-bubble-sm', 'flowcast-bubble-lg');
      if (this.size === 'sm') this.el.classList.add('flowcast-bubble-sm');
      if (this.size === 'lg') this.el.classList.add('flowcast-bubble-lg');
    }

    toggle() {
      this.visible = !this.visible;
      this.el.style.display = this.visible ? 'block' : 'none';
      return this.visible;
    }

    destroy() {
      if (this.audioAnimFrame) cancelAnimationFrame(this.audioAnimFrame);
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      if (this.el) this.el.remove();
    }
  }

  // ============================================================
  //  3. CONTROL BAR
  // ============================================================

  class ControlBar {
    constructor(callbacks) {
      this.callbacks = callbacks; // { onStop, onPause, onResume, onMuteToggle, onDrawToggle, onSpotlightToggle, onCamToggle, onClear }
      this.el = null;
      this.timerEl = null;
      this.pauseBtn = null;
      this.muteBtn = null;
      this.drawBtn = null;
      this.spotlightBtn = null;
      this.camBtn = null;
      this.timerInterval = null;
      this.seconds = 0;
      this.isPaused = false;
      this.isMuted = false;
      this.isDrawing = false;
      this.isSpotlight = false;
      this.isCamOn = true;
      this.emojiBtn = null;
    }

    create() {
      this.el = document.createElement('div');
      this.el.className = 'flowcast-controls';

      // Stop button
      const stopBtn = this.makeButton(ICONS.stop, 'Stop Recording', 'flowcast-stop-btn');
      stopBtn.addEventListener('click', () => this.callbacks.onStop());

      // Pause/Resume button
      this.pauseBtn = this.makeButton(ICONS.pause, 'Pause');
      this.pauseBtn.addEventListener('click', () => this.togglePause());

      // Divider
      const div1 = this.makeDivider();

      // Timer
      this.timerEl = document.createElement('span');
      this.timerEl.className = 'flowcast-timer';
      this.timerEl.textContent = '00:00';

      // Divider
      const div2 = this.makeDivider();

      // Mute button
      this.muteBtn = this.makeButton(ICONS.mic, 'Mute Mic');
      this.muteBtn.addEventListener('click', () => this.toggleMute());

      // Camera toggle
      this.camBtn = this.makeButton(ICONS.camOn, 'Toggle Camera');
      this.camBtn.addEventListener('click', () => this.toggleCam());

      // Divider
      const div3 = this.makeDivider();

      // Draw button
      this.drawBtn = this.makeButton(ICONS.draw, 'Draw on Screen');
      this.drawBtn.addEventListener('click', () => this.toggleDraw());

      // Spotlight button
      this.spotlightBtn = this.makeButton(ICONS.spotlight, 'Spotlight Mode');
      this.spotlightBtn.addEventListener('click', () => this.toggleSpotlight());

      // Emoji reactions button
      this.emojiBtn = this.makeButton(ICONS.emoji, 'Reaction Emojis');
      this.emojiBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleEmojiMenu();
      });

      // Assemble
      this.el.append(stopBtn, this.pauseBtn, div1, this.timerEl, div2, this.muteBtn, this.camBtn, div3, this.drawBtn, this.spotlightBtn, this.emojiBtn);

      document.body.appendChild(this.el);
      this.startTimer();
    }

    makeButton(iconHtml, title, extraClass = '') {
      const btn = document.createElement('button');
      btn.className = `flowcast-ctrl-btn ${extraClass}`.trim();
      btn.innerHTML = iconHtml;
      btn.title = title;
      return btn;
    }

    makeDivider() {
      const d = document.createElement('div');
      d.className = 'flowcast-ctrl-divider';
      return d;
    }

    startTimer() {
      this.seconds = 0;
      this.timerInterval = setInterval(() => {
        if (!this.isPaused) {
          this.seconds++;
          this.timerEl.textContent = this.formatTime(this.seconds);
        }
      }, 1000);
    }

    formatTime(totalSeconds) {
      const mins = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
      const secs = (totalSeconds % 60).toString().padStart(2, '0');
      return `${mins}:${secs}`;
    }

    togglePause() {
      this.isPaused = !this.isPaused;
      this.pauseBtn.innerHTML = this.isPaused ? ICONS.resume : ICONS.pause;
      this.pauseBtn.title = this.isPaused ? 'Resume' : 'Pause';
      this.timerEl.classList.toggle('flowcast-paused', this.isPaused);
      if (this.isPaused) {
        this.callbacks.onPause();
      } else {
        this.callbacks.onResume();
      }
    }

    toggleMute() {
      this.isMuted = !this.isMuted;
      this.muteBtn.innerHTML = this.isMuted ? ICONS.micOff : ICONS.mic;
      this.muteBtn.title = this.isMuted ? 'Unmute' : 'Mute';
      this.muteBtn.classList.toggle('flowcast-active', this.isMuted);
      this.callbacks.onMuteToggle(this.isMuted);
    }

    toggleDraw() {
      this.isDrawing = !this.isDrawing;
      this.drawBtn.classList.toggle('flowcast-active', this.isDrawing);

      // Turn off spotlight if enabling draw
      if (this.isDrawing && this.isSpotlight) {
        this.isSpotlight = false;
        this.spotlightBtn.classList.remove('flowcast-active');
        this.callbacks.onSpotlightToggle(false);
      }

      this.callbacks.onDrawToggle(this.isDrawing);
    }

    toggleSpotlight() {
      this.isSpotlight = !this.isSpotlight;
      this.spotlightBtn.classList.toggle('flowcast-active', this.isSpotlight);

      // Turn off drawing if enabling spotlight
      if (this.isSpotlight && this.isDrawing) {
        this.isDrawing = false;
        this.drawBtn.classList.remove('flowcast-active');
        this.callbacks.onDrawToggle(false);
      }

      this.callbacks.onSpotlightToggle(this.isSpotlight);
    }

    toggleCam() {
      this.isCamOn = !this.isCamOn;
      this.camBtn.innerHTML = this.isCamOn ? ICONS.camOn : ICONS.camOff;
      this.camBtn.title = this.isCamOn ? 'Hide Camera' : 'Show Camera';
      this.callbacks.onCamToggle(this.isCamOn);
    }

    toggleEmojiMenu() {
      const existing = this.el.querySelector('.flowcast-emoji-popover');
      if (existing) {
        existing.remove();
        return;
      }

      const popover = document.createElement('div');
      popover.className = 'flowcast-emoji-popover';
      
      const rect = this.emojiBtn.getBoundingClientRect();
      const controlsRect = this.el.getBoundingClientRect();
      popover.style.left = (rect.left - controlsRect.left - 20) + 'px';

      const emojis = ['👍', '🎉', '❤️', '😂', '💡'];
      emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'flowcast-emoji-option';
        btn.textContent = emoji;
        btn.addEventListener('click', () => {
          this.callbacks.onEmojiReaction(emoji);
          popover.remove();
        });
        popover.appendChild(btn);
      });

      this.el.appendChild(popover);

      const closeHandler = () => {
        popover.remove();
        document.removeEventListener('click', closeHandler);
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 50);
    }

    setPausedState(paused) {
      this.isPaused = paused;
      this.pauseBtn.innerHTML = paused ? ICONS.resume : ICONS.pause;
      this.timerEl.classList.toggle('flowcast-paused', paused);
    }

    destroy() {
      if (this.timerInterval) clearInterval(this.timerInterval);
      if (this.el) this.el.remove();
    }
  }

  // ============================================================
  //  4. ANNOTATION CANVAS (Fading Ink + Spotlight)
  // ============================================================

  class AnnotationCanvas {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.isActive = false;
      this.isDrawingStroke = false;
      this.strokes = []; // { points: [], color, width, createdAt }
      this.currentColor = '#ef4444'; // Default red
      this.lineWidth = 4;
      this.fadeDuration = 3000; // ms before strokes fade
      this.animFrame = null;
      this.palette = null;

      // Spotlight
      this.spotlightCanvas = null;
      this.spotlightCtx = null;
      this.spotlightActive = false;
      this.mousePos = { x: 0, y: 0 };
      this.ripples = [];
    }

    create() {
      // Main drawing canvas
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'flowcast-annotation-canvas';
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
      this.ctx = this.canvas.getContext('2d');
      document.body.appendChild(this.canvas);

      // Spotlight canvas (behind annotations)
      this.spotlightCanvas = document.createElement('canvas');
      this.spotlightCanvas.className = 'flowcast-spotlight-overlay';
      this.spotlightCanvas.width = window.innerWidth;
      this.spotlightCanvas.height = window.innerHeight;
      this.spotlightCtx = this.spotlightCanvas.getContext('2d');
      document.body.appendChild(this.spotlightCanvas);

      // Handle window resize
      window.addEventListener('resize', () => {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.spotlightCanvas.width = window.innerWidth;
        this.spotlightCanvas.height = window.innerHeight;
      });

      // Track mouse for spotlight
      document.addEventListener('mousemove', (e) => {
        this.mousePos.x = e.clientX;
        this.mousePos.y = e.clientY;
      });

      // Listen for global clicks to draw ripples
      document.addEventListener('click', (e) => {
        // Prevent click ripple if clicking FlowCast controls or palettes
        if (e.target.closest('.flowcast-controls') || e.target.closest('.flowcast-camera-bubble') || e.target.closest('.flowcast-draw-palette') || e.target.closest('.flowcast-emoji-popover')) return;
        this.ripples.push({
          x: e.clientX,
          y: e.clientY,
          radius: 5,
          maxRadius: 35,
          color: this.currentColor,
          createdAt: Date.now()
        });
      });

      // Bind drawing events
      this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
      this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
      this.canvas.addEventListener('mouseup', () => this.onMouseUp());
      this.canvas.addEventListener('mouseleave', () => this.onMouseUp());

      // Start the render loop
      this.render();
    }

    setActive(active) {
      this.isActive = active;
      this.canvas.classList.toggle('flowcast-drawing-active', active);

      if (active) {
        this.showPalette();
      } else {
        this.hidePalette();
      }
    }

    setSpotlight(active) {
      this.spotlightActive = active;
      this.spotlightCanvas.style.opacity = active ? '1' : '0';
    }

    // ── Drawing Events ─────────────────────────────────

    onMouseDown(e) {
      if (!this.isActive) return;
      this.isDrawingStroke = true;
      const stroke = {
        points: [{ x: e.clientX, y: e.clientY }],
        color: this.currentColor,
        width: this.lineWidth,
        createdAt: Date.now(),
      };
      this.strokes.push(stroke);
    }

    onMouseMove(e) {
      if (!this.isDrawingStroke || !this.isActive) return;
      const stroke = this.strokes[this.strokes.length - 1];
      stroke.points.push({ x: e.clientX, y: e.clientY });
    }

    onMouseUp() {
      this.isDrawingStroke = false;
    }

    // ── Render Loop ────────────────────────────────────

    render() {
      this.animFrame = requestAnimationFrame(() => this.render());

      const now = Date.now();

      // Clear canvas
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      // Draw strokes with fading
      this.strokes = this.strokes.filter((stroke) => {
        const age = now - stroke.createdAt;
        if (age > this.fadeDuration + 500) return false; // Remove fully faded strokes

        const opacity = Math.max(0, 1 - age / this.fadeDuration);
        this.drawStroke(stroke, opacity);
        return opacity > 0;
      });

      // Render spotlight
      if (this.spotlightActive) {
        this.renderSpotlight();
      } else {
        this.spotlightCtx.clearRect(0, 0, this.spotlightCanvas.width, this.spotlightCanvas.height);
      }

      // Draw click ripples
      this.ripples = this.ripples.filter((ripple) => {
        const age = now - ripple.createdAt;
        const duration = 500; // 500ms animation
        if (age > duration) return false;

        const progress = age / duration;
        const radius = 5 + (ripple.maxRadius - 5) * progress;
        const opacity = 1 - progress;

        this.ctx.beginPath();
        this.ctx.strokeStyle = ripple.color;
        this.ctx.globalAlpha = opacity;
        this.ctx.lineWidth = 3 * (1 - progress);
        this.ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.globalAlpha = 1;

        return true;
      });
    }

    drawStroke(stroke, opacity) {
      if (stroke.points.length < 2) return;

      this.ctx.beginPath();
      this.ctx.strokeStyle = stroke.color;
      this.ctx.globalAlpha = opacity;
      this.ctx.lineWidth = stroke.width;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        // Use quadratic curves for smoother lines
        const prev = stroke.points[i - 1];
        const curr = stroke.points[i];
        const midX = (prev.x + curr.x) / 2;
        const midY = (prev.y + curr.y) / 2;
        this.ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
      }
      this.ctx.stroke();
      this.ctx.globalAlpha = 1;
    }

    renderSpotlight() {
      const ctx = this.spotlightCtx;
      const w = this.spotlightCanvas.width;
      const h = this.spotlightCanvas.height;

      ctx.clearRect(0, 0, w, h);

      // Fill with dark overlay
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(0, 0, w, h);

      // Cut out a circle around the mouse position
      ctx.globalCompositeOperation = 'destination-out';
      const gradient = ctx.createRadialGradient(
        this.mousePos.x, this.mousePos.y, 0,
        this.mousePos.x, this.mousePos.y, 140
      );
      gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
      gradient.addColorStop(0.7, 'rgba(0, 0, 0, 0.8)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(this.mousePos.x, this.mousePos.y, 140, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = 'source-over';
    }

    // ── Drawing Palette ────────────────────────────────

    showPalette() {
      if (this.palette) return;

      this.palette = document.createElement('div');
      this.palette.className = 'flowcast-draw-palette';

      const colors = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff'];

      colors.forEach((color) => {
        const dot = document.createElement('button');
        dot.className = 'flowcast-color-dot';
        if (color === this.currentColor) dot.classList.add('flowcast-active');
        dot.style.background = color;
        dot.addEventListener('click', () => {
          this.currentColor = color;
          this.palette.querySelectorAll('.flowcast-color-dot').forEach(d => d.classList.remove('flowcast-active'));
          dot.classList.add('flowcast-active');
        });
        this.palette.appendChild(dot);
      });

      // Divider
      const div = document.createElement('div');
      div.className = 'flowcast-ctrl-divider';
      this.palette.appendChild(div);

      // Clear button
      const clearBtn = document.createElement('button');
      clearBtn.className = 'flowcast-ctrl-btn';
      clearBtn.innerHTML = ICONS.clear;
      clearBtn.title = 'Clear All';
      clearBtn.addEventListener('click', () => {
        this.strokes = [];
      });
      this.palette.appendChild(clearBtn);

      document.body.appendChild(this.palette);
    }

    hidePalette() {
      if (this.palette) {
        this.palette.remove();
        this.palette = null;
      }
    }

    clear() {
      this.strokes = [];
    }

    destroy() {
      if (this.animFrame) cancelAnimationFrame(this.animFrame);
      this.hidePalette();
      if (this.canvas) this.canvas.remove();
      if (this.spotlightCanvas) this.spotlightCanvas.remove();
    }
  }

  // ============================================================
  //  5. PROCESSING OVERLAY
  // ============================================================

  class ProcessingOverlay {
    constructor() {
      this.el = null;
    }

    show() {
      this.el = document.createElement('div');
      this.el.className = 'flowcast-processing-overlay';

      const spinner = document.createElement('div');
      spinner.className = 'flowcast-spinner';

      const text = document.createElement('div');
      text.className = 'flowcast-processing-text';
      text.textContent = 'Saving recording...';

      this.el.appendChild(spinner);
      this.el.appendChild(text);
      document.body.appendChild(this.el);
    }

    remove() {
      if (this.el) this.el.remove();
    }
  }

  // ============================================================
  //  6. MAIN CONTROLLER
  // ============================================================

  class FlowCastController {
    constructor() {
      this.countdown = new CountdownOverlay();
      this.cameraBubble = null;
      this.controlBar = null;
      this.annotationCanvas = null;
      this.processingOverlay = new ProcessingOverlay();
      this.settings = null;
      this._isInitialized = false;
    }

    /**
     * Handle messages from the Service Worker.
     */
    handleMessage(message, sendResponse) {
      switch (message.type) {
        case 'INIT_RECORDING_UI':
          this.initUI(message.settings, message.skipCountdown);
          sendResponse({ success: true });
          break;

        case 'SHOW_CONTROLS':
          this.showControls();
          sendResponse({ success: true });
          break;

        case 'UPDATE_STATE':
          this.updateState(message.status);
          sendResponse({ success: true });
          break;

        case 'REMOVE_RECORDING_UI':
          this.destroy();
          sendResponse({ success: true });
          break;

        default:
          break;
      }
    }

    async initUI(settings, skipCountdown = false) {
      if (this._isInitialized) {
        this.destroy();
      }
      this._isInitialized = true;
      this.settings = settings;

      // Create the annotation canvas (behind everything else)
      this.annotationCanvas = new AnnotationCanvas();
      this.annotationCanvas.create();

      // Create camera bubble if camera is enabled
      if (settings.camEnabled) {
        this.cameraBubble = new CameraBubble();
        await this.cameraBubble.init(settings.camId);
      }

      if (!skipCountdown) {
        // Show 3-2-1 countdown
        await this.countdown.show();

        // Notify the Service Worker that countdown is done
        chrome.runtime.sendMessage({ type: 'COUNTDOWN_COMPLETE' });
      }
    }

    showControls() {
      if (this.controlBar) return; // Already showing

      this.controlBar = new ControlBar({
        onStop: () => {
          chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
        },
        onPause: () => {
          chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
        },
        onResume: () => {
          chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
        },
        onMuteToggle: (muted) => {
          // Mute/unmute mic in the content script's camera bubble stream
          if (this.cameraBubble?.stream) {
            this.cameraBubble.stream.getAudioTracks().forEach(t => {
              t.enabled = !muted;
            });
          }
          // Also tell offscreen to mute mic
          chrome.runtime.sendMessage({ type: muted ? 'OFFSCREEN_MUTE_MIC' : 'OFFSCREEN_UNMUTE_MIC' });
        },
        onDrawToggle: (active) => {
          this.annotationCanvas?.setActive(active);
        },
        onSpotlightToggle: (active) => {
          this.annotationCanvas?.setSpotlight(active);
        },
        onCamToggle: (visible) => {
          this.cameraBubble?.toggle();
        },
        onClear: () => {
          this.annotationCanvas?.clear();
        },
        onEmojiReaction: (emoji) => {
          this.spawnEmojiReaction(emoji);
        },
      });

      this.controlBar.create();
    }

    updateState(status) {
      if (status === 'paused') {
        this.controlBar?.setPausedState(true);
      } else if (status === 'recording') {
        this.controlBar?.setPausedState(false);
      } else if (status === 'processing') {
        this.controlBar?.destroy();
        this.controlBar = null;
        this.annotationCanvas?.setActive(false);
        this.annotationCanvas?.setSpotlight(false);
        this.processingOverlay.show();
      }
    }

    spawnEmojiReaction(emoji) {
      // Find camera bubble position to float from
      let startX = window.innerWidth / 2;
      let startY = window.innerHeight - 150;
      
      if (this.cameraBubble?.el && this.cameraBubble.visible) {
        const rect = this.cameraBubble.el.getBoundingClientRect();
        startX = rect.left + rect.width / 2;
        startY = rect.top + rect.height / 2;
      } else {
        if (this.controlBar?.el) {
          const rect = this.controlBar.el.getBoundingClientRect();
          startX = rect.left + rect.width / 2;
          startY = rect.top;
        }
      }
      
      const count = 10;
      for (let i = 0; i < count; i++) {
        const el = document.createElement('div');
        el.className = 'flowcast-floating-emoji';
        el.textContent = emoji;
        el.style.left = startX + 'px';
        el.style.top = startY + 'px';
        
        const xStart = (Math.random() - 0.5) * 40;
        const yStart = (Math.random() - 0.5) * 40;
        const xEnd = (Math.random() - 0.5) * 220;
        const rotate = (Math.random() - 0.5) * 120;
        
        el.style.setProperty('--x-offset-start', `${xStart}px`);
        el.style.setProperty('--y-offset-start', `${yStart}px`);
        el.style.setProperty('--x-offset-end', `${xEnd}px`);
        el.style.setProperty('--rotate-angle', `${rotate}deg`);
        
        el.style.animationDelay = `${Math.random() * 0.3}s`;
        
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2000);
      }
    }

    destroy() {
      this.cameraBubble?.destroy();
      this.controlBar?.destroy();
      this.annotationCanvas?.destroy();
      this.processingOverlay.remove();
      this.countdown.remove();

      this.cameraBubble = null;
      this.controlBar = null;
      this.annotationCanvas = null;

      // Allow re-injection
      window.__flowcast_injected = false;
      this._isInitialized = false;
    }
  }

  // ============================================================
  //  BOOTSTRAP
  // ============================================================

  const controller = new FlowCastController();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    controller.handleMessage(message, sendResponse);
    return true;
  });

})();
