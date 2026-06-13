# FlowCast - Document of Reasoning

## 1. Project Understanding

The assignment was to build a Chrome extension similar to Loom, but with a better user experience. I treated the problem as more than a screen recorder. Loom is valuable because it makes asynchronous communication easier, so the product needed to help a user feel confident before recording, expressive while recording, and productive after recording.

The expected deliverables were:

- Chrome extension zip
- GitHub link for the code
- Document of reasoning
- Screen recording or demo video

The marking scheme gave high weight to clarity of thought, UI/UX, code quality, and thinking out of the box. Based on that, I prioritized a polished end-to-end extension over a large but unfinished feature set.

## 2. Product Goal

The product is called FlowCast. It is a Manifest V3 Chrome extension for recording the screen with optional camera and microphone input. It also adds presenter tools such as a draggable camera bubble, countdown, floating controls, annotations, spotlight mode, emoji reactions, local saving, and a post-recording preview/library experience.

The core goal was:

> Let a user quickly create a clear, expressive screen recording without needing a heavy external app.

## 3. Prioritization Strategy

Because the test was time-bound, I focused on the highest-impact parts of the experience:

1. Recording must work reliably.
2. The user should know their camera and microphone are working before they start.
3. The recording controls should feel obvious while recording.
4. The final recording should be easy to review, rename, download, and manage.
5. The implementation should stay understandable and easy to debug.

This meant I avoided spending time on backend upload, authentication, team workspaces, billing, comments, or cloud sharing. Those would make sense in a production Loom competitor, but they would increase scope without proving the most important browser-extension skills.

## 4. Main Features Built

### Popup Experience

The popup is designed as the user's setup panel before recording. It includes:

- Recording mode selection
- Screen + camera mode
- Screen-only mode
- Camera selector
- Microphone selector
- Quality selector: 720p, 1080p, and 4K
- Live camera preview
- Microphone level meter
- Permission overlay for microphone and camera access
- Clear error feedback

The live camera preview and mic meter were important UX decisions. Many recording tools fail because the user only discovers after recording that their microphone was muted or the wrong camera was selected. FlowCast tries to catch that problem before the recording starts.

### Recording Flow

After the user starts recording:

- The extension checks that the active tab is recordable.
- The service worker creates an offscreen document.
- The offscreen document asks for screen capture and microphone access.
- A content script injects the countdown and recording UI into the page.
- The user gets a 3-2-1 countdown.
- Recording begins only after the countdown completes.

This flow keeps the experience predictable. The countdown also gives the user a small moment to switch mental context before presenting.

### On-Page Recording Controls

The content script injects a floating toolbar directly into the recorded page. It includes:

- Stop recording
- Pause/resume
- Timer
- Microphone mute/unmute
- Camera show/hide
- Drawing tool
- Spotlight tool
- Emoji reactions

The toolbar is intentionally compact and icon-driven. During recording, the user should not need to read long instructions. The controls should be available, but not dominate the screen.

### Camera Bubble

The camera bubble provides a Loom-like presenter presence. It includes:

- Circular webcam overlay
- Draggable positioning
- Snap-to-edge behavior
- Double-click size cycling
- Fallback state if camera loading fails

The snap-to-edge behavior was chosen because free-floating camera bubbles often block important content. Snapping to the nearest side keeps the bubble useful without constantly getting in the user's way.

### Presenter Tools

FlowCast includes tools that make recordings easier to follow:

- Fading ink annotations
- Spotlight mode around the cursor
- Mouse click ripples
- Emoji reactions

These features were included to improve communication quality, not just visual flair. In tutorials or product demos, the viewer often needs to know where to look and what action happened. Drawing, spotlight, and click ripples help with that.

### Recording Engine

The offscreen document handles the heavy media work:

- `getDisplayMedia()` for screen capture
- `getUserMedia()` for microphone capture
- Web Audio API for mixing system audio and microphone audio
- `MediaRecorder` for creating WebM recordings
- Quality-aware video constraints and bitrates
- IndexedDB saving

This separation is required by Manifest V3 because the service worker cannot directly use DOM and media APIs.

### Preview and Library

After recording, the extension opens a preview page. This page includes:

- Library dashboard
- Recording cards sorted by date
- Hover preview playback
- Custom video player
- Rename recording title
- Download recording
- Copy local viewer link
- Delete recording
- Metadata chips for duration, format, quality, and size
- Timestamped notes
- Click-to-seek notes
- Copy notes

This was built because recording is only half of the user journey. A good Loom-like tool should make the output easy to review and reuse.

## 5. Architecture Reasoning

Chrome Manifest V3 creates several technical constraints. The architecture was designed around those constraints instead of fighting them.

### Service Worker as Orchestrator

The background service worker manages the recording lifecycle:

- Idle
- Preparing
- Countdown
- Recording
- Paused
- Processing

It routes messages between popup, offscreen document, content script, and preview page.

### Offscreen Document for Media Work

Manifest V3 service workers do not have access to normal DOM and media APIs. For that reason, FlowCast uses an offscreen document to run:

- Screen capture
- Microphone capture
- Audio mixing
- MediaRecorder
- Recording save logic

This keeps the media pipeline in a browser context that supports the required APIs.

### Content Script for Visible UI

The recording UI must appear inside the recorded tab so it can be visible during screen capture. A content script is used for:

- Countdown overlay
- Floating toolbar
- Camera bubble
- Drawing canvas
- Spotlight overlay
- Click ripples
- Emoji reactions

### IndexedDB for Local Storage

Recordings are saved in IndexedDB because video blobs can be large and should not be stored in regular extension storage. IndexedDB also allows the offscreen recorder and preview page to share the same local recording data.

## 6. User Experience Reasoning

The UX goal was to reduce anxiety and friction across three stages.

### Before Recording

Problems users face:

- Wrong microphone selected
- Camera not working
- Not knowing whether permission is granted
- Accidentally recording the wrong thing

FlowCast addresses this with:

- Live camera preview
- Mic meter
- Device selectors
- Permission overlay
- Error messages for non-recordable pages

### During Recording

Problems users face:

- Losing track of recording state
- Needing to pause quickly
- Needing to highlight an area
- Camera bubble covering content

FlowCast addresses this with:

- Countdown
- Timer
- Floating controls
- Pause/resume
- Mute/unmute
- Snap-to-edge camera bubble
- Drawing and spotlight tools

### After Recording

Problems users face:

- Finding the saved recording
- Previewing the result
- Downloading the video
- Adding context
- Managing old recordings

FlowCast addresses this with:

- Preview page
- Recording library
- Hover previews
- Rename support
- Timestamped notes
- Download/delete actions

## 7. Why I Used Vanilla JavaScript Instead of React

I initially tried creating a React version with AI assistance, but it introduced more issues than it solved for this project. For a normal web app, React can be a great choice. For this Chrome extension, especially under Manifest V3 and a short deadline, vanilla JavaScript was the better engineering decision.

### 1. Chrome Extension Contexts Are Split

This extension is not a single-page app. It has multiple independent contexts:

- Popup page
- Background service worker
- Offscreen document
- Content script injected into arbitrary websites
- Camera iframe
- Preview page
- Permissions page

React is most useful when there is one main application tree. Here, the project is several small surfaces connected by Chrome messaging. Vanilla JavaScript maps directly to that structure.

### 2. Content Scripts Need Precise DOM Control

The content script injects UI into any website the user records. This requires careful control over:

- Element creation
- CSS isolation
- z-index
- Cleanup
- Event listeners
- Avoiding conflicts with host pages

Using React inside a content script added complexity around mounting, unmounting, style collisions, bundling, and hydration-like behavior. Direct DOM APIs made this easier to reason about and debug.

### 3. No Build Step Means Fewer Failure Points

Vanilla JavaScript made the extension load directly in Chrome using the source files. There is no dependency on:

- Vite/Webpack configuration
- React build output
- Bundled chunk paths
- Source map issues
- MV3 CSP conflicts
- Extra dependency installation

For a take-home project, this is valuable because the evaluator can clone or unzip the project and load it immediately.

### 4. Manifest V3 Has Strict Rules

Manifest V3 has restrictions around service workers, extension pages, permissions, and content security policy. React itself is not the problem, but a React toolchain can create issues such as:

- Generated scripts not matching manifest paths
- Inline runtime behavior conflicting with extension CSP
- Asset path problems after build
- Larger bundled files
- More difficult debugging across extension contexts

Vanilla JavaScript kept the code close to the Chrome Extension APIs and reduced the number of moving parts.

### 5. AI-Generated React Created More Integration Bugs

When I tried using AI to create the React version, it was faster at generating UI, but slower at producing a working extension. The issues were mostly integration-related:

- Components assumed a normal browser web app environment.
- State management did not align cleanly with Chrome runtime messaging.
- Build output needed extra manifest changes.
- Content script behavior became harder to debug.
- Permissions and offscreen media handling were easier to implement directly.

The vanilla version was simpler, more transparent, and easier to fix when something went wrong.

### 6. Smaller Runtime and Better Startup

Extension popups should open instantly. Content scripts should inject quickly. Vanilla JavaScript avoids shipping React and a renderer runtime into each extension surface. This keeps the extension lighter and helps the popup, controls, and injected UI feel more responsive.

### 7. The UI Was Interactive, But Not State-Heavy Enough to Need React

The project has interactive pieces, but most are self-contained:

- Popup selectors
- Recording toolbar
- Camera bubble
- Canvas annotation
- Preview player
- Notes list

These do not require a large component system. Small classes and focused DOM functions were enough.

For these reasons, vanilla JavaScript was not a compromise. It was the better fit for this extension's architecture, browser constraints, evaluation flow, and debugging speed.

## 8. Code Quality Decisions

I kept the code organized by extension responsibility:

- `manifest.json` defines permissions, extension metadata, background worker, popup, and web-accessible resources.
- `background/service-worker.js` manages lifecycle and messaging.
- `offscreen/offscreen.js` handles capture, audio mixing, recording, and saving.
- `content/content.js` owns injected recording UI.
- `popup/popup.js` owns setup, permissions, device selection, and live preview.
- `preview/preview.js` owns library, player, metadata, notes, and recording management.
- `utils/db.js` provides a small IndexedDB API.

The main quality goals were:

- Clear separation of contexts
- Minimal dependencies
- Easy local loading
- Explicit state transitions
- Graceful permission and capture errors
- Cleanup of streams and injected UI
- Local-first data storage

## 9. Tradeoffs and Limitations

Because this was scoped as a take-home project, I made a few deliberate tradeoffs:

- Recordings are stored locally instead of uploaded to cloud storage.
- Copy link copies a local preview URL, not a public hosted URL.
- Authentication and team sharing are not included.
- Video editing and trimming are not included.
- Cross-browser support is focused on Chrome.
- Transcription was considered, but the current implementation focuses on timestamped notes rather than a full reliable transcript pipeline.

These tradeoffs keep the submission focused on the Chrome extension experience and avoid unfinished backend work.

## 10. Testing and Verification Plan

The extension should be tested manually because media capture and Chrome permissions are browser-level workflows.

Recommended test cases:

1. Load the unpacked extension from `chrome://extensions`.
2. Open a normal `https://` website.
3. Open FlowCast from the extension icon.
4. Grant microphone and camera permission.
5. Confirm camera preview works.
6. Confirm microphone meter reacts to voice.
7. Start screen + camera recording.
8. Verify countdown appears.
9. Verify floating toolbar appears.
10. Drag camera bubble and confirm it snaps to an edge.
11. Double-click camera bubble and confirm it changes size.
12. Pause and resume recording.
13. Mute and unmute microphone.
14. Use drawing mode and confirm ink fades.
15. Use spotlight mode and confirm the cursor focus effect.
16. Trigger emoji reaction.
17. Stop recording.
18. Confirm preview page opens.
19. Play the recording.
20. Rename the recording.
21. Add a timestamped note and click it to seek.
22. Download the recording.
23. Return to library and confirm the recording appears.
24. Delete a recording and confirm it is removed.

## 11. Thinking Out of the Box

The assignment asked for a Loom-like extension, but I tried to add value in areas that improve communication:

- Mic meter before recording
- Camera preview before recording
- Snap-to-edge camera bubble
- Fading annotations instead of permanent clutter
- Spotlight mode for focus
- Click ripples for tutorial clarity
- Emoji reactions for expressive demos
- Local library dashboard
- Hover preview cards
- Timestamped notes with click-to-seek

These features make the product feel less like a raw recorder and more like a tool for creating understandable walkthroughs.

## 12. Final Summary

FlowCast is a Chrome extension built to show strong product thinking, UI/UX polish, and practical engineering under time constraints. The implementation uses Manifest V3 correctly, separates responsibilities across extension contexts, records media through an offscreen document, injects lightweight presenter tools into the active tab, and stores recordings locally in IndexedDB.

The choice to use vanilla JavaScript was intentional. After trying a React approach with AI, vanilla JavaScript proved more reliable for this multi-context Chrome extension because it reduced build complexity, avoided MV3 integration issues, improved debugging speed, and gave precise control over injected DOM behavior.
