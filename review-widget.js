/**
 * VideoReviewWidget — Drop-in timestamped video review tool
 * No dependencies. One file. Works inside any page.
 *
 * Usage:
 *   ReviewWidget.init({ container: '#video-review-widget' });
 *
 * Files: dailyRushes client review format 1 (see review-format.md). The
 * editor sends a review file ("kind": "review"); the client exports a
 * comments file ("kind": "comments") with their comments and a "check"
 * block recording the video they actually watched and every warning they
 * were shown. Files in any other format are refused.
 *
 * The same drop zone also opens a comments file: the video opens with every
 * comment listed and marked on the progress bar, and any warnings the
 * client saw are shown.
 *
 * Timecode matches the editor's timeline: startFrame + inFrame + frame.
 * "frameRate" (e.g. "23.976") turns video seconds into frames, so
 * 23.976 / 29.97 / 59.94 reviews don't drift.
 *
 * For browser tools: the .vrw-root element carries the review settings and
 * the current position as data attributes (see publishConfig and
 * publishPosition), e.g. data-vrw-tc="01:00:12:03" data-vrw-frame="0".
 */

const ReviewWidget = (() => {

  // ─── state ──────────────────────────────────────────────────────────
  let video = null;
  let fps = 24;              // nominal rate, used inside timecode
  let rate = 24;             // exact rate, used to turn seconds into frames
  let configFrameRate = '';  // the rate as written in the review file ("23.976")
  let dropFrame = false;
  let startFrame = 0;
  let startTimecode = '';
  let rootEl = null;
  let projectName = '';
  let clientName = '';
  let videoSrc = '';
  let comments = [];
  let commentIdCounter = 0;
  let progressBar = null;
  let progressFilled = null;
  let dotLayer = null;
  let timecodeDisplay = null;
  let commentList = null;
  let commentInput = null;
  let commentInputWrap = null;
  let pendingTimecode = null;
  let pendingFrame = null;
  let containerEl = null;
  let loadingOverlay = null;
  let progressBuffered = null;
  let loadedInfo = null;     // set when a comments file was loaded: { count, client, exportDate }
  let docEventsBound = false; // document-level listeners are added once, not on every rebuild
  let dragging = false;       // progress-bar scrub in progress

  // config round-trip fields (carried from editor's JSON → client export)
  let configTimeline = '';
  let configProduction = '';
  let configScene = '';
  let configTake = '';
  let configTimelineLength = '';
  let configInFrame = null;
  let configOutFrame = null;
  let configInTC = '';
  let configOutTC = '';
  let configEditorMessage = '';
  let configEditorNotes = '';
  let fileKind = 'review';   // "review" or "comments": what was opened

  // Problems the client was warned about. Written into the comments file's
  // check.warnings so the editor's tools know. Each: { type, message,
  // dismissed, confirmed, at }. type: durationMismatch | videoError | beyondEnd
  let warnings = [];
  let videoSecondsSeen = null; // length of the video, once it has loaded

  // ─── helpers ────────────────────────────────────────────────────────

  // ─── timecode ───────────────────────────────────────────────────────
  // exactRate, secondsToFrame, frameToSeconds, framesToTC and tcToFrames are
  // copies of the same functions in Marker Edits' lib.js. Keep them identical.
  // Frames here are counted from the start of the review video; the timeline
  // position is startFrame + inFrame + frame.

  function exactRate(setting) {
    const n = parseFloat(setting);
    if (!isFinite(n) || n <= 0) return 24;
    const nominal = Math.round(n);
    const ntsc = nominal * 1000 / 1001;
    if (Math.abs(n - nominal) > 0.001 && Math.abs(n - ntsc) < 0.01) return ntsc;
    return n;
  }

  function canDropFrame(r) {
    const nominal = Math.round(r);
    return (nominal === 30 || nominal === 60) && Math.abs(r - nominal) > 0.001;
  }

  function secondsToFrame(secs, r) {
    return Math.max(0, Math.floor(secs * r + 1e-3));
  }

  function frameToSeconds(frame, r) {
    return (frame + 0.5) / r;
  }

  function tcToFrames(tc, nominal, df) {
    const m = /(\d+):(\d+):(\d+)[:;.](\d+)/.exec(String(tc || ''));
    if (!m) return NaN;
    const h = +m[1], mi = +m[2], s = +m[3], f = +m[4];
    let frames = (h * 3600 + mi * 60 + s) * nominal + f;
    if (df && (nominal === 30 || nominal === 60)) {
      const drop = nominal / 15;
      const totalMinutes = h * 60 + mi;
      frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
    }
    return frames;
  }

  function framesToTC(frame, nominal, df) {
    frame = Math.max(0, Math.round(frame));
    let sep = ':';
    if (df && (nominal === 30 || nominal === 60)) {
      const drop = nominal / 15;
      const per10 = nominal * 600 - drop * 9;
      const perMin = nominal * 60 - drop;
      const tens = Math.floor(frame / per10);
      const rem = frame % per10;
      frame += drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMin) : 0);
      sep = ';';
    }
    const f = frame % nominal;
    const tot = Math.floor(frame / nominal);
    return pad(Math.floor(tot / 3600)) + ':' + pad(Math.floor(tot / 60) % 60) + ':' + pad(tot % 60) + sep + pad(f);
  }

  // Where frame 0 of the review video sits, in timecode frames.
  function tcOffset() {
    return startFrame + (configInFrame || 0);
  }

  function frameToTC(frame) {
    return framesToTC(tcOffset() + frame, fps, dropFrame);
  }

  function secsToFrame(totalSecs) {
    return secondsToFrame(totalSecs, rate);
  }

  function secsToTC(totalSecs) {
    return frameToTC(secsToFrame(totalSecs));
  }

  // The time of the frame on screen. The widget always seeks to the middle
  // of a frame, so currentTime has half a frame of room either side.
  // (requestVideoFrameCallback was tried and dropped: right after a seek it
  // can still report the previous frame.)
  function currentSecs() {
    return video ? video.currentTime : 0;
  }

  function currentFrame() {
    return secsToFrame(currentSecs());
  }

  function lastFrame() {
    return video && video.duration ? Math.max(0, Math.ceil(video.duration * rate - 1e-3) - 1) : Infinity;
  }

  // Seek to the middle of a frame, so rounding can never land on its neighbour.
  function seekToFrame(frame) {
    if (!video) return;
    const f = Math.max(0, Math.min(lastFrame(), Math.round(frame)));
    video.pause();
    video.currentTime = frameToSeconds(f, rate);
    updateProgress();
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // ─── data attributes for browser tools ──────────────────────────────

  function publishConfig() {
    if (!rootEl) return;
    const d = rootEl.dataset;
    d.vrwVersion = '2';
    d.vrwFps = String(fps);
    d.vrwFrameRate = configFrameRate || String(fps);
    d.vrwDropFrame = String(dropFrame);
    d.vrwTimelineTc = 'true';
    d.vrwStartFrame = String(startFrame);
    d.vrwStartTc = startTimecode;
    d.vrwInFrame = String(configInFrame || 0);
    d.vrwOutFrame = String(configOutFrame || 0);
  }

  function publishPosition() {
    if (!rootEl || !video) return;
    const f = currentFrame();
    const d = rootEl.dataset;
    d.vrwFrame = String(f);                    // frames from the start of the video
    d.vrwTimelineFrame = String((configInFrame || 0) + f); // frames from the start of the timeline
    d.vrwTc = frameToTC(f);
    d.vrwPaused = String(video.paused);
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'className') e.className = attrs[k];
        else if (k === 'textContent') e.textContent = attrs[k];
        else if (k === 'innerHTML') e.innerHTML = attrs[k];
        else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      if (!Array.isArray(children)) children = [children];
      children.forEach(c => {
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
      });
    }
    return e;
  }

  // ─── styles (scoped via .vrw- prefix) ───────────────────────────────

  function injectStyles() {
    if (document.getElementById('vrw-styles')) return;
    const css = `
      .vrw-root {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #e0e0e0;
        background: #1a1a1a;
        border-radius: 8px;
        overflow: hidden;
        max-width: 960px;
        margin: 0 auto;
      }

      .vrw-root * { box-sizing: border-box; }

      /* ── drop zone / load screen ── */
      .vrw-dropzone {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 300px;
        padding: 40px 20px;
        text-align: center;
      }
      .vrw-dropzone-icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.7;
      }
      .vrw-dropzone-title {
        font-size: 18px;
        font-weight: 600;
        color: #e0e0e0;
        margin-bottom: 8px;
      }
      .vrw-dropzone-subtitle {
        font-size: 14px;
        color: #888;
        margin-bottom: 20px;
      }
      .vrw-dropzone-or {
        font-size: 13px;
        color: #666;
        margin: 12px 0;
      }
      .vrw-dropzone.vrw-dragover {
        background: #1a3a5c;
        outline: 2px dashed #2b7de9;
        outline-offset: -8px;
      }
      .vrw-root.vrw-dragover {
        outline: 2px dashed #2b7de9;
        outline-offset: -4px;
      }

      /* ── editor message panel ── */
      .vrw-editor-message {
        background: #252530;
        border-left: 3px solid #2b7de9;
        padding: 10px 14px;
        margin: 0;
        font-size: 13px;
        color: #bbb;
        max-height: 150px;
        overflow-y: auto;
      }
      .vrw-editor-message-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #2b7de9;
        margin-bottom: 4px;
        font-weight: 600;
      }
      .vrw-editor-message-text {
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* ── loaded comments banner ── */
      .vrw-loaded-banner {
        background: #1a3a5c;
        border-left: 3px solid #FFD700;
        padding: 8px 14px;
        font-size: 13px;
        color: #d8e6f5;
      }

      /* comment that lies past the end of the video */
      .vrw-comment-item.vrw-comment-beyond .vrw-comment-tc { color: #e6a817; }
      .vrw-comment-item.vrw-comment-beyond .vrw-comment-text { opacity: 0.7; }

      /* ── video ── */
      .vrw-video-wrap {
        position: relative;
        background: #000;
        line-height: 0;
      }
      .vrw-video-wrap video {
        width: 100%;
        display: block;
      }

      /* ── loading overlay ── */
      .vrw-loading-overlay {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.5);
        z-index: 10;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s;
      }
      .vrw-loading-overlay.vrw-visible {
        opacity: 1;
        pointer-events: auto;
      }
      .vrw-spinner {
        width: 48px;
        height: 48px;
        border: 4px solid rgba(255, 255, 255, 0.2);
        border-top-color: #2b7de9;
        border-radius: 50%;
        animation: vrw-spin 0.8s linear infinite;
      }
      .vrw-loading-label {
        color: #ccc;
        font-size: 13px;
        margin-top: 10px;
        text-align: center;
      }
      @keyframes vrw-spin {
        to { transform: rotate(360deg); }
      }

      /* ── progress bar ── */
      .vrw-progress-wrap {
        position: relative;
        height: 24px;
        background: #333;
        cursor: pointer;
        user-select: none;
      }
      .vrw-progress-buffered {
        height: 100%;
        background: rgba(255, 255, 255, 0.15);
        width: 0%;
        pointer-events: none;
        position: absolute;
        top: 0; left: 0;
      }
      .vrw-progress-filled {
        height: 100%;
        background: #2b7de9;
        width: 0%;
        pointer-events: none;
        position: absolute;
        top: 0; left: 0;
      }
      .vrw-dot-layer {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        pointer-events: none;
      }
      .vrw-dot {
        position: absolute;
        top: 3px;
        width: 8px;
        height: 18px;
        background: #FFD700;
        border-radius: 2px;
        transform: translateX(-50%);
        pointer-events: all;
        cursor: pointer;
        opacity: 0.85;
        transition: opacity 0.15s;
      }
      .vrw-dot:hover {
        opacity: 1;
        background: #fff;
      }

      /* ── controls ── */
      .vrw-controls {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        background: #222;
        flex-wrap: wrap;
      }
      .vrw-btn {
        background: #2b7de9;
        color: #fff;
        border: none;
        padding: 7px 14px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
      }
      .vrw-btn:hover { background: #1a6ad4; }
      .vrw-btn-secondary {
        background: #444;
      }
      .vrw-btn-secondary:hover { background: #555; }
      .vrw-btn-comment {
        background: #e6a817;
        color: #000;
      }
      .vrw-btn-comment:hover { background: #f5be2e; }
      .vrw-timecode {
        font-family: "SF Mono", "Consolas", "Courier New", monospace;
        font-size: 14px;
        color: #ccc;
        padding: 0 8px;
        min-width: 110px;
        text-align: center;
      }
      .vrw-spacer { flex: 1; }

      /* ── comment input ── */
      .vrw-comment-input-wrap {
        display: none;
        padding: 10px 12px;
        background: #292929;
        border-top: 1px solid #333;
      }
      .vrw-comment-input-wrap.vrw-active { display: block; }
      .vrw-comment-input-header {
        font-size: 13px;
        color: #FFD700;
        margin-bottom: 6px;
      }
      .vrw-comment-textarea {
        width: 100%;
        min-height: 60px;
        padding: 8px;
        background: #d0d0d0;
        color: #000;
        border: 1px solid #555;
        border-radius: 4px;
        font-family: inherit;
        font-size: 13px;
        resize: vertical;
      }
      .vrw-comment-textarea:focus {
        outline: none;
        border-color: #2b7de9;
      }
      .vrw-comment-submit-row {
        display: flex;
        gap: 6px;
        margin-top: 6px;
      }

      /* ── comment list ── */
      .vrw-comment-list {
        max-height: 320px;
        overflow-y: auto;
        padding: 0;
        margin: 0;
        list-style: none;
        background: #1e1e1e;
      }
      .vrw-comment-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid #2a2a2a;
        cursor: pointer;
        transition: background 0.15s;
      }
      .vrw-comment-item:hover { background: #292929; }
      .vrw-comment-item.vrw-active-comment { background: #1a3a5c; }
      .vrw-comment-tc {
        font-family: "SF Mono", "Consolas", "Courier New", monospace;
        font-size: 12px;
        color: #2b7de9;
        white-space: nowrap;
        min-width: 100px;
        padding-top: 2px;
      }
      .vrw-comment-text {
        font-size: 13px;
        color: #ccc;
        flex: 1;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .vrw-comment-actions {
        display: flex;
        gap: 2px;
        flex-shrink: 0;
      }
      .vrw-comment-edit,
      .vrw-comment-delete {
        background: none;
        border: none;
        color: #666;
        cursor: pointer;
        font-size: 14px;
        padding: 0 4px;
        line-height: 1;
      }
      .vrw-comment-edit:hover { color: #2b7de9; }
      .vrw-comment-delete:hover { color: #e55; }

      /* inline edit mode */
      .vrw-edit-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .vrw-edit-textarea {
        width: 100%;
        min-height: 50px;
        padding: 6px;
        background: #d0d0d0;
        color: #000;
        border: 1px solid #2b7de9;
        border-radius: 4px;
        font-family: inherit;
        font-size: 13px;
        resize: vertical;
      }
      .vrw-edit-textarea:focus {
        outline: none;
        border-color: #1a6ad4;
      }
      .vrw-edit-btns {
        display: flex;
        gap: 4px;
      }
      .vrw-edit-btns button {
        padding: 3px 10px;
        font-size: 12px;
        border-radius: 3px;
        border: none;
        cursor: pointer;
      }
      .vrw-edit-save {
        background: #2b7de9;
        color: #fff;
      }
      .vrw-edit-save:hover { background: #1a6ad4; }
      .vrw-edit-cancel {
        background: #444;
        color: #ccc;
      }
      .vrw-edit-cancel:hover { background: #555; }

      /* ── footer ── */
      .vrw-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: #222;
        border-top: 1px solid #333;
        font-size: 12px;
        color: #888;
        flex-wrap: wrap;
        gap: 6px;
      }

      .vrw-footer-buttons {
        display: flex;
        gap: 6px;
      }

      /* ── empty state ── */
      .vrw-empty {
        padding: 20px 12px;
        text-align: center;
        color: #666;
        font-size: 13px;
        font-style: italic;
      }

      /* ── export confirmation ── */
      .vrw-export-confirm {
        padding: 10px 14px;
        background: #1a5c2a;
        color: #d0f0d0;
        font-size: 13px;
        text-align: center;
        transition: opacity 0.4s;
      }

      /* ── duration mismatch warning ── */
      .vrw-mismatch-warn {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 14px;
        background: #5c3a1a;
        border-left: 3px solid #e6a817;
        margin: 0;
        font-size: 13px;
        color: #f0ddb0;
      }
      .vrw-mismatch-icon {
        font-size: 20px;
        flex-shrink: 0;
        line-height: 1.2;
      }
      .vrw-mismatch-text strong {
        color: #FFD700;
      }
      .vrw-mismatch-dismiss {
        background: none;
        border: 1px solid rgba(255,215,0,0.3);
        color: #FFD700;
        cursor: pointer;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 3px;
        margin-top: 6px;
        white-space: nowrap;
      }
      .vrw-mismatch-dismiss:hover {
        background: rgba(255,215,0,0.1);
      }
      .vrw-mismatch-slim {
        padding: 5px 14px;
        align-items: center;
      }
      .vrw-mismatch-slim .vrw-mismatch-icon { font-size: 15px; }
      .vrw-mismatch-slim .vrw-mismatch-dismiss { margin-top: 0; margin-left: 6px; }
      .vrw-export-confirm.vrw-notice-warn {
        background: #5c3a1a;
        color: #f0ddb0;
      }

      /* ── video error warning ── */
      .vrw-video-error {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 14px;
        background: #5c1a1a;
        border-left: 3px solid #e84040;
        margin: 0;
        font-size: 13px;
        color: #f0c0b0;
      }
      .vrw-video-error strong {
        color: #ff6b6b;
      }
      .vrw-video-error code {
        display: inline-block;
        background: rgba(0,0,0,0.3);
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 12px;
        word-break: break-all;
        color: #f0c0b0;
      }

      /* ── keyboard help ── */
      .vrw-keyboard-help {
        padding: 8px 12px;
        background: #252525;
        border-top: 1px solid #333;
        font-size: 12px;
        color: #777;
      }
      .vrw-keyboard-help strong {
        color: #aaa;
      }
      .vrw-kbd {
        display: inline-block;
        background: #3a3a3a;
        border: 1px solid #555;
        border-radius: 3px;
        padding: 1px 6px;
        font-family: inherit;
        font-size: 11px;
        color: #ccc;
        margin: 0 1px;
      }

      /* ── responsive ── */
      @media (max-width: 600px) {
        .vrw-controls { gap: 4px; padding: 6px 8px; }
        .vrw-btn { padding: 6px 10px; font-size: 12px; }
        .vrw-timecode { font-size: 12px; min-width: 90px; }
        .vrw-dropzone { min-height: 220px; padding: 24px 16px; }
        .vrw-dropzone-icon { font-size: 36px; }
      }
    `;
    const style = el('style', { id: 'vrw-styles' });
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ─── JSON load screen ──────────────────────────────────────────────

  function showLoadScreen() {
    const root = el('div', { className: 'vrw-root' });

    const dropzone = el('div', { className: 'vrw-dropzone' });

    dropzone.appendChild(el('div', { className: 'vrw-dropzone-icon', textContent: '📂' }));
    dropzone.appendChild(el('div', { className: 'vrw-dropzone-title', textContent: 'Load Review File' }));
    dropzone.appendChild(el('div', { className: 'vrw-dropzone-subtitle', textContent: 'Drag & drop a Client Review JSON, or a client\'s comments JSON, here' }));

    // file input (hidden)
    const fileInput = el('input', { type: 'file', accept: '.json' });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        loadJSONFile(fileInput.files[0]);
      }
    });

    dropzone.appendChild(el('div', { className: 'vrw-dropzone-or', textContent: '— or —' }));
    dropzone.appendChild(el('button', {
      className: 'vrw-btn',
      textContent: 'Choose File…',
      onClick: () => fileInput.click()
    }));
    dropzone.appendChild(fileInput);

    // drag events
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('vrw-dragover');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('vrw-dragover');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('vrw-dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        loadJSONFile(e.dataTransfer.files[0]);
      }
    });

    root.appendChild(dropzone);
    containerEl.innerHTML = '';
    containerEl.appendChild(root);
  }

  // Format 1 only. Returns a message for the person, or '' if the file is fine.
  function problemWith(data) {
    if (!data || typeof data !== 'object') return 'This file is not a review file.';
    if (data.format !== 1) return 'This file is not in the current review format. Ask your editor to send it again.';
    if (data.kind !== 'review' && data.kind !== 'comments') return 'This file is not a review file or a comments file.';
    const texts = ['project', 'timeline', 'client', 'production', 'scene', 'take', 'timelineLength', 'video',
      'frameRate', 'startTimecode', 'inTC', 'outTC', 'editorMessage', 'editorNotes', 'exportDate'];
    for (const k of texts) if (typeof data[k] !== 'string') return 'The review file is missing "' + k + '".';
    for (const k of ['fps', 'startFrame', 'inFrame', 'outFrame']) {
      if (typeof data[k] !== 'number' || !isFinite(data[k])) return 'The review file is missing "' + k + '".';
    }
    if (typeof data.dropFrame !== 'boolean') return 'The review file is missing "dropFrame".';
    if (!data.video.trim()) return 'The review file has no video link.';
    if (!(data.outFrame > data.inFrame)) return 'The review file\'s Out point is not after its In point.';
    if (data.kind === 'comments') {
      if (!data.check || typeof data.check !== 'object' || !Array.isArray(data.check.warnings)) return 'The comments file is missing its "check" section.';
      if (!Array.isArray(data.comments)) return 'The comments file has no comments list.';
      for (const c of data.comments) {
        if (!c || typeof c.frame !== 'number' || !isFinite(c.frame) || typeof c.comment !== 'string') return 'A comment in this file has no frame or text.';
      }
    }
    return '';
  }

  function loadJSONFile(file) {
    if (!/\.json$/i.test(file.name || '')) {
      alert('Only review files (.json) can be opened here.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      let data;
      try {
        data = JSON.parse(e.target.result);
      } catch (err) {
        alert('Could not read this file:\n' + err.message);
        return;
      }
      const problem = problemWith(data);
      if (problem) { alert(problem); return; }
      applyConfig(data);
      if (data.kind === 'comments') {
        loadComments(data.comments);
        // The editor opening a client's file sees what the client was warned about.
        warnings = data.check.warnings.map((w) => Object.assign({}, w));
        loadedInfo = { count: comments.length, client: data.client || '', exportDate: data.exportDate || '' };
      } else {
        comments = [];
        commentIdCounter = 0;
        warnings = [];
        loadedInfo = null;
      }
      buildReviewUI();
    };
    reader.onerror = () => {
      alert('Error reading file.');
    };
    reader.readAsText(file);
  }

  function loadNewJSONWithWarning(file) {
    if (comments.length > 0) {
      const ok = confirm(
        'You have ' + comments.length + ' unsaved comment' +
        (comments.length === 1 ? '' : 's') +
        '.\n\nExport them first, or click OK to discard and load the new file.'
      );
      if (!ok) return;
    }
    comments = [];
    commentIdCounter = 0;
    loadJSONFile(file);
  }

  function openNewJSONPicker() {
    const input = el('input', { type: 'file', accept: '.json' });
    input.style.display = 'none';
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) {
        loadNewJSONWithWarning(input.files[0]);
      }
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  // Turn a comments file's "comments" list into the widget's own comment
  // list. Every comment has a frame (checked when the file was opened); the
  // timecode shown is worked out again from it. Empty comments are skipped.
  function loadComments(list) {
    comments = [];
    commentIdCounter = 0;
    list.forEach(c => {
      const text = c.comment.trim();
      if (!text) return;
      const frame = Math.max(0, Math.round(c.frame));
      comments.push({
        id: ++commentIdCounter,
        timecode: frameToTC(frame),
        frame: frame,
        seconds: frame / rate,
        text: text
      });
    });
  }

  // True once the video length is known and the comment lies past its end
  // (e.g. a comments file dropped onto the wrong or a shorter video).
  function isBeyondEnd(c) {
    return !!(video && video.duration && c.seconds > video.duration + 0.05);
  }

  // The file has passed problemWith(), so every field is present.
  function applyConfig(data) {
    fileKind = data.kind;
    projectName = data.project;
    clientName = data.client;
    videoSrc = data.video.trim();
    configFrameRate = data.frameRate;
    rate = exactRate(configFrameRate);
    fps = Math.round(data.fps) || Math.round(rate) || 24;
    dropFrame = data.dropFrame && canDropFrame(rate);
    startFrame = Math.round(data.startFrame);
    startTimecode = data.startTimecode;
    configTimeline = data.timeline;
    configProduction = data.production;
    configScene = data.scene;
    configTake = data.take;
    configTimelineLength = data.timelineLength;
    configInFrame = Math.round(data.inFrame);
    configOutFrame = Math.round(data.outFrame);
    configInTC = data.inTC;
    configOutTC = data.outTC;
    configEditorMessage = data.editorMessage;
    configEditorNotes = data.editorNotes;
    videoSecondsSeen = null;
  }

  // ─── warnings ───────────────────────────────────────────────────────
  // One entry per type; a repeat updates the message.
  function addWarning(type, message) {
    let w = warnings.find(x => x.type === type);
    if (!w) {
      w = { type, message, dismissed: false, confirmed: false, at: new Date().toISOString() };
      warnings.push(w);
    } else {
      w.message = message;
    }
    return w;
  }

  function expectedFrames() {
    return configOutFrame - configInFrame;
  }

  // Nearest second (the Generator and Marker Edits round the same way).
  function fmtLength(s) {
    const t = Math.round(s);
    const m = Math.floor(t / 60);
    const sec = t % 60;
    return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
  }

  // ─── progress bar & dots ────────────────────────────────────────────

  function updateProgress() {
    if (!video || !video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    progressFilled.style.width = pct + '%';
    timecodeDisplay.textContent = frameToTC(currentFrame());
    publishPosition();
    highlightActiveComment();
  }

  function updateBuffered() {
    if (!video || !video.duration || !progressBuffered) return;
    const buf = video.buffered;
    if (buf.length > 0) {
      // show the furthest buffered point
      const end = buf.end(buf.length - 1);
      const pct = (end / video.duration) * 100;
      progressBuffered.style.width = pct + '%';
    }
  }

  function showLoading(show) {
    if (!loadingOverlay) return;
    if (show) {
      loadingOverlay.classList.add('vrw-visible');
    } else {
      loadingOverlay.classList.remove('vrw-visible');
    }
  }

  function seekFromClick(e) {
    const rect = progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * video.duration;
    updateProgress();
  }

  function renderDots() {
    dotLayer.innerHTML = '';
    if (!video || !video.duration) return;
    comments.forEach(c => {
      if (isBeyondEnd(c)) return;  // listed with a warning instead of a dot off the end of the bar
      const pct = (c.seconds / video.duration) * 100;
      const dot = el('div', {
        className: 'vrw-dot',
        title: c.timecode + ' — ' + c.text.substring(0, 40),
        onClick: (e) => {
          e.stopPropagation();
          seekToFrame(c.frame);
        }
      });
      dot.style.left = pct + '%';
      dotLayer.appendChild(dot);
    });
  }

  // ─── comment list ───────────────────────────────────────────────────

  function enterEditMode(item, c) {
    if (item.querySelector('.vrw-edit-area')) return;

    const textSpan = item.querySelector('.vrw-comment-text');
    const actions = item.querySelector('.vrw-comment-actions');
    textSpan.style.display = 'none';
    actions.style.display = 'none';

    const textarea = el('textarea', { className: 'vrw-edit-textarea' });
    textarea.value = c.text;

    const saveBtn = el('button', { className: 'vrw-edit-save', textContent: 'Save' });
    const cancelBtn = el('button', { className: 'vrw-edit-cancel', textContent: 'Cancel' });

    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newText = textarea.value.trim();
      if (newText) {
        comments = comments.map(x => x.id === c.id ? { ...x, text: newText } : x);
      }
      renderComments();
      renderDots();
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editArea.remove();
      textSpan.style.display = '';
      actions.style.display = '';
    });

    const editArea = el('div', { className: 'vrw-edit-area' }, [
      textarea,
      el('div', { className: 'vrw-edit-btns' }, [saveBtn, cancelBtn])
    ]);

    textSpan.parentNode.insertBefore(editArea, textSpan.nextSibling);
    textarea.focus();
    textarea.selectionStart = textarea.value.length;

    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveBtn.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelBtn.click();
      }
    });
  }

  function renderComments() {
    commentList.innerHTML = '';
    if (comments.length === 0) {
      commentList.appendChild(el('li', {
        className: 'vrw-empty',
        textContent: 'No comments yet — pause the video and click "Add Comment" to begin.'
      }));
      return;
    }

    const sorted = [...comments].sort((a, b) => a.seconds - b.seconds);
    sorted.forEach(c => {
      const textSpan = el('span', { className: 'vrw-comment-text', textContent: c.text });
      const editBtn = el('button', {
        className: 'vrw-comment-edit',
        title: 'Edit comment',
        textContent: 'Edit',
      });
      const deleteBtn = el('button', {
        className: 'vrw-comment-delete',
        title: 'Delete comment',
        textContent: '✕',
      });
      const actions = el('div', { className: 'vrw-comment-actions' }, [editBtn, deleteBtn]);

      const beyond = isBeyondEnd(c);
      const item = el('li', {
        className: 'vrw-comment-item' + (beyond ? ' vrw-comment-beyond' : ''),
        'data-id': c.id,
        title: beyond ? 'This comment is after the end of this video' : ''
      }, [
        el('span', { className: 'vrw-comment-tc', textContent: (beyond ? '⚠ ' : '') + c.timecode }),
        textSpan,
        actions
      ]);

      item.addEventListener('click', () => {
        seekToFrame(c.frame);
      });

      textSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        enterEditMode(item, c);
      });

      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        enterEditMode(item, c);
      });

      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        comments = comments.filter(x => x.id !== c.id);
        renderComments();
        renderDots();
      });

      commentList.appendChild(item);
    });

    renderDots();
  }

  function highlightActiveComment() {
    if (!video) return;
    const items = commentList.querySelectorAll('.vrw-comment-item');
    const cur = video.currentTime;
    let closest = null;
    let closestDist = Infinity;
    comments.forEach(c => {
      const d = Math.abs(c.seconds - cur);
      if (d < closestDist && d < 1) {
        closestDist = d;
        closest = c.id;
      }
    });
    items.forEach(item => {
      if (item.getAttribute('data-id') == closest) {
        item.classList.add('vrw-active-comment');
      } else {
        item.classList.remove('vrw-active-comment');
      }
    });
  }

  // ─── comment input ──────────────────────────────────────────────────

  function openCommentInput() {
    video.pause();
    pendingFrame = currentFrame();
    pendingTimecode = frameToTC(pendingFrame);
    commentInputWrap.classList.add('vrw-active');
    commentInputWrap.querySelector('.vrw-comment-input-header').textContent =
      'Comment at ' + pendingTimecode + '  (frame ' + pendingFrame + ')';
    commentInput.value = '';
    commentInput.focus();
  }

  function submitComment() {
    const text = commentInput.value.trim();
    if (!text) return;
    comments.push({
      id: ++commentIdCounter,
      timecode: pendingTimecode,
      frame: pendingFrame,
      seconds: pendingFrame / rate,
      text: text
    });
    commentInputWrap.classList.remove('vrw-active');
    commentInput.value = '';
    renderComments();
  }

  function cancelComment() {
    commentInputWrap.classList.remove('vrw-active');
    commentInput.value = '';
  }

  // ─── step controls ─────────────────────────────────────────────────

  function stepBack() {
    seekToFrame(currentFrame() - 1);
  }

  function stepForward() {
    seekToFrame(currentFrame() + 1);
  }

  function prevComment() {
    if (!comments.length) return;
    const sorted = [...comments].sort((a, b) => a.seconds - b.seconds);
    const cur = video.currentTime - 0.1;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].seconds < cur) {
        seekToFrame(sorted[i].frame);
        return;
      }
    }
    seekToFrame(sorted[sorted.length - 1].frame);
  }

  function nextComment() {
    if (!comments.length) return;
    const sorted = [...comments].sort((a, b) => a.seconds - b.seconds);
    const cur = video.currentTime + 0.1;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].seconds > cur) {
        seekToFrame(sorted[i].frame);
        return;
      }
    }
    seekToFrame(sorted[0].frame);
  }

  // ─── export ─────────────────────────────────────────────────────────

  function exportJSON() {
    if (!comments.length) {
      showNotice('Add at least one comment before exporting: pause the video and click Add Comment.');
      return;
    }

    // Comments past the end of the video are worth telling the editor about.
    const beyond = comments.filter(isBeyondEnd).length;
    if (beyond) {
      addWarning('beyondEnd', beyond + ' comment' + (beyond === 1 ? ' is' : 's are') + ' after the end of the video.');
    }

    // Anything the client was warned about and hasn't yet agreed to send.
    const open = warnings.filter(w => !w.confirmed);
    if (open.length) {
      const ok = confirm(
        'Before you send your comments:\n\n' +
        open.map(w => '• ' + w.message).join('\n') +
        '\n\nYour comments may land in the wrong place in your editor\'s timeline. ' +
        'Your editor will be told about this.\n\nClick OK to export anyway, or Cancel to contact your editor first.'
      );
      if (!ok) return;
      open.forEach(w => { w.confirmed = true; });
    }

    // prompt for filename
    const defaultName = (projectName || 'review').replace(/\s+/g, '_') + '_comments';
    const userInput = prompt('Save comments as:', defaultName);
    if (!userInput) return; // cancelled

    // ensure .json extension
    const fileName = userInput.endsWith('.json') ? userInput : userInput + '.json';

    const sorted = [...comments].sort((a, b) => a.frame - b.frame);
    const expected = expectedFrames();
    const output = {
      format: 1,
      kind: 'comments',
      project: projectName,
      timeline: configTimeline,
      client: clientName,
      production: configProduction,
      scene: configScene,
      take: configTake,
      timelineLength: configTimelineLength,
      video: videoSrc,
      fps: fps,
      frameRate: configFrameRate,
      dropFrame: dropFrame,
      startFrame: startFrame,
      startTimecode: startTimecode,
      inFrame: configInFrame,
      outFrame: configOutFrame,
      inTC: configInTC,
      outTC: configOutTC,
      editorMessage: configEditorMessage,
      editorNotes: configEditorNotes,
      exportDate: new Date().toISOString(),
      check: {
        videoSeconds: videoSecondsSeen == null ? null : Math.round(videoSecondsSeen * 1000) / 1000,
        videoFrames: videoSecondsSeen == null ? null : Math.round(videoSecondsSeen * rate),
        expectedFrames: expected,
        expectedSeconds: Math.round(expected / rate * 1000) / 1000,
        warnings: warnings.map(w => ({ type: w.type, message: w.message, dismissed: !!w.dismissed, confirmed: !!w.confirmed, at: w.at }))
      },
      comments: sorted.map(c => ({
        frame: c.frame,
        timecode: c.timecode,
        comment: c.text
      }))
    };
    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // confirmation
    showExportConfirm(fileName);
  }

  // A short message at the bottom of the review, gone after a few seconds.
  function showNotice(text, ok) {
    const root = containerEl.querySelector('.vrw-root');
    if (!root) return;
    const banner = el('div', { className: 'vrw-export-confirm' + (ok ? '' : ' vrw-notice-warn'), textContent: text });
    root.appendChild(banner);
    setTimeout(() => {
      banner.style.opacity = '0';
      setTimeout(() => banner.remove(), 400);
    }, 4000);
  }

  function showExportConfirm(fileName) {
    showNotice('Exported as ' + fileName + ' — check your Downloads folder', true);
  }

  // ─── duration mismatch check ────────────────────────────────────────

  function checkDurationMismatch() {
    if (!video || !video.duration) return;
    videoSecondsSeen = video.duration;
    if (fileKind === 'comments') return; // an opened comments file shows the client's own warnings

    const expectedSecs = expectedFrames() / rate;
    const actualSecs = video.duration;
    // allow 1.5 second tolerance for container padding / trailing frames
    if (Math.abs(actualSecs - expectedSecs) <= 1.5) return;

    const message = 'The review range is ' + fmtLength(expectedSecs) +
      ' (' + configInTC + ' → ' + configOutTC + ')' +
      ' but this video file is ' + fmtLength(actualSecs) + '. ' +
      'Comments may not align with the correct timecodes in the editor\'s timeline.';
    const w = addWarning('durationMismatch', message);
    showDurationBanner(w);
  }

  // The full warning, until the client clicks Dismiss. Dismissing shrinks it
  // to a slim strip that stays in view, since the client is still commenting
  // on a video that may not match; the strip opens the full warning again.
  function showDurationBanner(w) {
    const root = containerEl.querySelector('.vrw-root');
    if (!root) return;
    const old = root.querySelector('.vrw-mismatch-warn');
    if (old) old.remove();

    let banner;
    if (w.dismissed) {
      banner = el('div', { className: 'vrw-mismatch-warn vrw-mismatch-slim' }, [
        el('span', { className: 'vrw-mismatch-icon', textContent: '⚠' }),
        el('div', { className: 'vrw-mismatch-text' }, [
          document.createTextNode('This video does not match the review range, so comments may land in the wrong place. '),
          el('button', {
            className: 'vrw-mismatch-dismiss',
            textContent: 'Details',
            onClick: () => { w.dismissed = false; showDurationBanner(w); }
          })
        ])
      ]);
    } else {
      banner = el('div', { className: 'vrw-mismatch-warn' }, [
        el('span', { className: 'vrw-mismatch-icon', textContent: '⚠' }),
        el('div', { className: 'vrw-mismatch-text' }, [
          el('strong', { textContent: 'Duration mismatch: ' }),
          document.createTextNode(w.message),
          el('br'),
          el('span', {
            style: 'font-size:12px; opacity:0.85;',
            textContent: 'Please contact the person who sent you this review to check you have the right video. Your editor will be told about this when you send your comments.'
          }),
          el('br'),
          el('button', {
            className: 'vrw-mismatch-dismiss',
            textContent: 'Dismiss',
            onClick: () => { w.dismissed = true; showDurationBanner(w); }
          })
        ])
      ]);
    }
    placeBanner(root, banner);
  }

  // Warnings go after the editor's message, or after the video.
  function placeBanner(root, banner) {
    const panels = root.querySelectorAll('.vrw-editor-message');
    const editorMsg = panels.length ? panels[panels.length - 1] : null;
    const videoWrap = root.querySelector('.vrw-video-wrap');
    const insertAfter = editorMsg || videoWrap;
    if (insertAfter && insertAfter.nextSibling) {
      root.insertBefore(banner, insertAfter.nextSibling);
    } else {
      root.insertBefore(banner, root.firstChild);
    }
  }

  // ─── video load error check ──────────────────────────────────────────

  function handleVideoError() {
    const root = containerEl.querySelector('.vrw-root');
    if (!root) return;

    // hide loading overlay if visible
    showLoading(false);

    // determine reason from MediaError code + fetch probe
    const errCode = video && video.error ? video.error.code : 0;
    const errMessages = {
      1: 'Video loading was aborted.',
      2: 'A network error stopped the video loading. Check your internet connection and try again.',
      3: 'The video file could not be decoded — it may be corrupt or use an unsupported codec.',
    };

    // codes 1–3 are specific enough to display directly
    if (errCode >= 1 && errCode <= 3) {
      showVideoErrorBanner(root, errMessages[errCode]);
      return;
    }

    // Code 4 (source not supported) is vague: a wrong link, a missing file
    // and an unplayable format all look the same. Asking the server is only
    // possible for a video on the same website as this page. Anywhere else
    // (a page opened from the computer, a Dropbox or other site link) the
    // browser blocks the question even when the video itself is fine, so
    // the reply would be misleading. Give practical advice instead.
    let target = null;
    try { target = new URL(videoSrc, location.href); } catch (_) { /* unreadable address */ }
    const sameSite = !!target && /^https?:$/.test(location.protocol) && target.origin === location.origin;

    if (!sameSite) {
      if (target && target.protocol === 'file:') {
        showVideoErrorBanner(root,
          'The video file could not be played. Check that it is in the place the review expects ' +
          '(for example the videos folder next to review.html) and that it is an MP4 file.');
      } else {
        showVideoErrorBanner(root,
          'The browser could not play the video at this link. Check that the link starts with https://, ' +
          'points to the video file itself (for example ending in .mp4), and is shared so that anyone with the link can view it. ' +
          'For Dropbox links, the link should end in raw=1.');
      }
      return;
    }

    fetch(target.href, { method: 'HEAD' })
      .then(function(response) {
        if (response.status === 404) {
          showVideoErrorBanner(root, 'Video file not found (404). The link may be wrong, or the video may have been moved or deleted.');
        } else if (response.status === 403) {
          showVideoErrorBanner(root, 'Access to the video was refused (403). The video may not be shared publicly.');
        } else if (response.ok) {
          showVideoErrorBanner(root,
            'The video file was found but the browser cannot play it. The format may not be supported: an H.264 MP4 plays in every browser.');
        } else {
          showVideoErrorBanner(root,
            'Server returned status ' + response.status + ' for the video file.');
        }
      })
      .catch(function() {
        showVideoErrorBanner(root, 'The video could not be reached. Check your internet connection and try again.');
      });
  }

  function showVideoErrorBanner(root, reason) {
    if (fileKind !== 'comments') addWarning('videoError', 'Video could not be loaded: ' + reason);
    // remove any existing error banner
    const existing = root.querySelector('.vrw-video-error');
    if (existing) existing.remove();

    const banner = el('div', { className: 'vrw-video-error' }, [
      el('span', { className: 'vrw-mismatch-icon', textContent: '⚠' }),
      el('div', {}, [
        el('strong', { textContent: 'Video could not be loaded' }),
        el('br'),
        document.createTextNode(reason),
        el('br'),
        el('span', {
          style: 'font-size: 12px; margin-top: 4px; display: inline-block;'
        }, [
          document.createTextNode('Attempted: '),
          el('code', { textContent: videoSrc })
        ]),
        el('br'),
        el('span', {
          style: 'font-size: 12px; opacity: 0.85; margin-top: 4px; display: inline-block;',
          textContent: 'Please contact the person who sent you this review and ask them to check the video link.'
        })
      ])
    ]);

    placeBanner(root, banner);
  }

  // ─── keyboard shortcuts ─────────────────────────────────────────────

  function handleKeys(e) {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        video.paused ? video.play() : video.pause();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        stepBack();
        break;
      case 'ArrowRight':
        e.preventDefault();
        stepForward();
        break;
      case 'c':
      case 'C':
        e.preventDefault();
        openCommentInput();
        break;
    }
  }

  // ─── build the review interface ────────────────────────────────────

  function buildReviewUI() {
    const root = el('div', { className: 'vrw-root' });
    rootEl = root;
    publishConfig();

    // the editor's message and notes for the client
    if (configEditorMessage.trim()) {
      root.appendChild(el('div', { className: 'vrw-editor-message' }, [
        el('div', { className: 'vrw-editor-message-label', textContent: 'Message from editor' }),
        el('div', { className: 'vrw-editor-message-text', textContent: configEditorMessage })
      ]));
    }
    if (configEditorNotes.trim()) {
      root.appendChild(el('div', { className: 'vrw-editor-message' }, [
        el('div', { className: 'vrw-editor-message-label', textContent: 'Notes from editor' }),
        el('div', { className: 'vrw-editor-message-text', textContent: configEditorNotes })
      ]));
    }

    // loaded-comments banner (when a client's comments file was opened)
    if (loadedInfo) {
      let when = '';
      if (loadedInfo.exportDate) {
        const d = new Date(loadedInfo.exportDate);
        if (!isNaN(d)) when = ', exported ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      }
      root.appendChild(el('div', {
        className: 'vrw-loaded-banner',
        textContent: 'Showing ' + loadedInfo.count + ' comment' + (loadedInfo.count === 1 ? '' : 's') +
          (loadedInfo.client ? ' from ' + loadedInfo.client : '') + when +
          '. Click a comment, or its marker on the bar, to jump to it.'
      }));
      // what the client was warned about while commenting
      warnings.forEach(w => {
        root.appendChild(el('div', { className: 'vrw-mismatch-warn' }, [
          el('span', { className: 'vrw-mismatch-icon', textContent: '⚠' }),
          el('div', { className: 'vrw-mismatch-text' }, [
            el('strong', { textContent: 'The client was warned: ' }),
            document.createTextNode(w.message + (w.confirmed ? ' They chose to send anyway.' : ''))
          ])
        ]));
      });
    }

    // video
    const videoWrap = el('div', { className: 'vrw-video-wrap' });
    video = el('video', { src: videoSrc, preload: 'auto', playsinline: '', 'webkit-playsinline': '' });
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('loadedmetadata', () => {
      updateProgress();
      renderComments();   // redraws the list (flags any beyond the end) and the dots
      checkDurationMismatch();
    });
    video.addEventListener('error', handleVideoError);
    video.addEventListener('pause', publishPosition);
    video.addEventListener('seeked', updateProgress);

    // buffering events
    video.addEventListener('waiting', () => showLoading(true));
    video.addEventListener('playing', () => showLoading(false));
    video.addEventListener('canplay', () => showLoading(false));
    video.addEventListener('progress', updateBuffered);

    // loading overlay
    loadingOverlay = el('div', { className: 'vrw-loading-overlay' }, [
      el('div', { style: 'display:flex;flex-direction:column;align-items:center;' }, [
        el('div', { className: 'vrw-spinner' }),
        el('div', { className: 'vrw-loading-label', textContent: 'Buffering…' })
      ])
    ]);
    videoWrap.appendChild(video);
    videoWrap.appendChild(loadingOverlay);
    root.appendChild(videoWrap);

    // progress bar
    progressBar = el('div', { className: 'vrw-progress-wrap', onClick: seekFromClick });
    progressBuffered = el('div', { className: 'vrw-progress-buffered' });
    progressFilled = el('div', { className: 'vrw-progress-filled' });
    dotLayer = el('div', { className: 'vrw-dot-layer' });
    progressBar.appendChild(progressBuffered);
    progressBar.appendChild(progressFilled);
    progressBar.appendChild(dotLayer);

    dragging = false;
    progressBar.addEventListener('mousedown', (e) => { dragging = true; seekFromClick(e); });

    root.appendChild(progressBar);

    // controls
    timecodeDisplay = el('span', { className: 'vrw-timecode', textContent: '00:00:00:00' });
    const controls = el('div', { className: 'vrw-controls' }, [
      el('button', { className: 'vrw-btn', textContent: '⏵ Play', onClick: () => video.play() }),
      el('button', { className: 'vrw-btn', textContent: '⏸ Pause', onClick: () => video.pause() }),
      el('button', { className: 'vrw-btn vrw-btn-secondary', textContent: '◂ Frame', onClick: stepBack }),
      el('button', { className: 'vrw-btn vrw-btn-secondary', textContent: 'Frame ▸', onClick: stepForward }),
      timecodeDisplay,
      el('span', { className: 'vrw-spacer' }),
      el('button', { className: 'vrw-btn vrw-btn-secondary', textContent: '⏮ Prev', title: 'Previous comment', onClick: prevComment }),
      el('button', { className: 'vrw-btn vrw-btn-secondary', textContent: 'Next ⏭', title: 'Next comment', onClick: nextComment }),
      el('button', { className: 'vrw-btn vrw-btn-comment', textContent: '✚ Add Comment', onClick: openCommentInput }),
    ]);
    root.appendChild(controls);

    // comment input area (hidden until needed)
    commentInputWrap = el('div', { className: 'vrw-comment-input-wrap' });
    const commentHeader = el('div', { className: 'vrw-comment-input-header', textContent: '' });
    commentInput = el('textarea', {
      className: 'vrw-comment-textarea',
      placeholder: 'Type your comment here...'
    });
    commentInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitComment();
      }
      if (e.key === 'Escape') cancelComment();
    });
    const submitRow = el('div', { className: 'vrw-comment-submit-row' }, [
      el('button', { className: 'vrw-btn', textContent: 'Save Comment (Ctrl+Enter)', onClick: submitComment }),
      el('button', { className: 'vrw-btn vrw-btn-secondary', textContent: 'Cancel', onClick: cancelComment }),
    ]);
    commentInputWrap.appendChild(commentHeader);
    commentInputWrap.appendChild(commentInput);
    commentInputWrap.appendChild(submitRow);
    root.appendChild(commentInputWrap);

    // comment list
    commentList = el('ul', { className: 'vrw-comment-list' });
    root.appendChild(commentList);
    renderComments();

    // keyboard help
    const kbHelp = el('div', { className: 'vrw-keyboard-help' });
    kbHelp.innerHTML = '<strong>Keyboard shortcuts:</strong> ' +
      '<span class="vrw-kbd">Space</span> Play/Pause &nbsp; ' +
      '<span class="vrw-kbd">←</span> Step back one frame &nbsp; ' +
      '<span class="vrw-kbd">→</span> Step forward one frame &nbsp; ' +
      '<span class="vrw-kbd">C</span> Add comment';
    root.appendChild(kbHelp);

    // footer
    const infoParts = [projectName, clientName];
    if (configProduction) infoParts.push(configProduction);
    if (configScene || configTake) {
      const sceneTake = [configScene ? 'Sc ' + configScene : '', configTake ? 'Tk ' + configTake : ''].filter(Boolean).join(' / ');
      infoParts.push(sceneTake);
    }
    const info = infoParts.filter(Boolean).join(' — ') || 'Video Review';
    const footer = el('div', { className: 'vrw-footer' }, [
      el('span', { textContent: info }),
      el('span', { className: 'vrw-footer-buttons' }, [
        el('button', {
          className: 'vrw-btn vrw-btn-secondary',
          textContent: '📂 Open New',
          title: 'Load a different review JSON',
          onClick: openNewJSONPicker
        }),
        el('button', {
          className: 'vrw-btn',
          textContent: '⬇ Export Comments (JSON)',
          onClick: exportJSON
        })
      ])
    ]);
    root.appendChild(footer);

    // drag & drop JSON onto the review UI
    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('vrw-dragover');
    });
    root.addEventListener('dragleave', (e) => {
      if (!root.contains(e.relatedTarget)) {
        root.classList.remove('vrw-dragover');
      }
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('vrw-dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (/\.json$/i.test(file.name)) {
          loadNewJSONWithWarning(file);
        } else {
          showNotice('Only review files (.json) can be opened here.');
        }
      }
    });

    // Document-level listeners are added once. buildReviewUI runs again every
    // time a new file is loaded, and adding them each time made Space fire
    // twice (play then pause) after the second file.
    if (!docEventsBound) {
      document.addEventListener('keydown', handleKeys);
      document.addEventListener('mousemove', (e) => { if (dragging && progressBar) seekFromClick(e); });
      document.addEventListener('mouseup', () => { dragging = false; });
      docEventsBound = true;
    }

    // mount
    containerEl.innerHTML = '';
    containerEl.appendChild(root);
    publishPosition();
  }

  // ─── favicon ────────────────────────────────────────────────────────

const DEFAULT_FAVICON_SVG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg width="100%" height="100%" viewBox="0 0 32 32" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">' +
  '<defs>' +
  '<linearGradient id="_Linear1" x1="0" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse" gradientTransform="matrix(0,480,-480,0,16,16)"><stop offset="0" style="stop-color:rgb(30,32,40);stop-opacity:1"/><stop offset="1" style="stop-color:rgb(17,18,22);stop-opacity:1"/></linearGradient>' +
  '<linearGradient id="_Linear2" x1="0" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse" gradientTransform="matrix(170,-224,224,170,78,364)"><stop offset="0" style="stop-color:rgb(230,46,5);stop-opacity:1"/><stop offset="0.5" style="stop-color:rgb(255,90,31);stop-opacity:1"/><stop offset="1" style="stop-color:rgb(255,170,0);stop-opacity:1"/></linearGradient>' +
  '<linearGradient id="_Linear3" x1="0" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse" gradientTransform="matrix(208,-280,280,208,256,416)"><stop offset="0" style="stop-color:rgb(230,46,5);stop-opacity:1"/><stop offset="0.5" style="stop-color:rgb(255,90,31);stop-opacity:1"/><stop offset="1" style="stop-color:rgb(255,170,0);stop-opacity:1"/></linearGradient>' +
  '</defs>' +
  '<g transform="matrix(0.066667,0,0,0.066667,-1.066667,-1.066667)">' +
  '<path d="M384,16C445.814,16 496,66.186 496,128L496,384C496,445.814 445.814,496 384,496L128,496C66.186,496 16,445.814 16,384L16,128C16,66.186 66.186,16 128,16L384,16Z" style="fill:url(#_Linear1);"/>' +
  '</g>' +
  '<g transform="matrix(0.069122,0,0,0.069122,-2.210207,-2.395161)">' +
  '<g transform="matrix(1.073675,0,0,1.073675,-10.056311,-57.101094)">' +
  '<path d="M78,140L242,140L242,188L226,188C220,166 210,158 184,158L156,158L156,230L196,230C214,230 220,222 222,208L236,208L236,294L222,294C220,280 214,272 196,272L156,272L156,348L186,348C214,348 226,338 232,312L248,312L248,364L78,364L78,348C96,348 106,342 106,324L106,180C106,162 96,156 78,156L78,140Z" style="fill:url(#_Linear2);fill-rule:nonzero;"/>' +
  '</g>' +
  '<g transform="matrix(1.027983,0,0,1.027983,13.373746,34.403868)">' +
  '<path d="M416,196L402,196C396,172 380,156 352,156C324,156 304,172 304,196C304,220 326,236 362,254C406,276 432,304 432,340C432,390 388,416 338,416C298,416 268,398 256,364L272,358C282,384 306,398 334,398C366,398 388,378 388,350C388,322 364,304 322,284C282,264 260,238 260,204C260,162 300,136 346,136C403.041,134.826 417.935,185.696 416,196Z" style="fill:url(#_Linear3);fill-rule:nonzero;"/>' +
  '</g>' +
  '</g>' +
  '</svg>'
);

  function injectFavicon(customFavicon) {
    // if the host page already has a favicon, respect it
    if (document.querySelector('link[rel="icon"], link[rel="shortcut icon"]')) return;
    // remove any stale favicon links the browser might have cached against
    document.querySelectorAll('link[rel*="icon"]').forEach(l => l.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = customFavicon ? 'image/png' : 'image/svg+xml';
    link.href = customFavicon || DEFAULT_FAVICON_SVG;
    document.head.appendChild(link);
  }

  // ─── init ──────────────────────────────────────────────────────────

  function init(opts) {
    injectStyles();
    injectFavicon(opts.favicon);

    containerEl = typeof opts.container === 'string'
      ? document.querySelector(opts.container)
      : opts.container;

    if (!containerEl) {
      console.error('ReviewWidget: container not found');
      return;
    }

    showLoadScreen();
  }

  return { init };

})();