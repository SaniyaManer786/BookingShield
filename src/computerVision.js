/**
 * SMART ST Control Center - Computer Vision Monitoring Module
 *
 * Real-time browser camera stream with YOLOv8 person detection.
 *
 * The camera and the inference loop live in the shared vision camera service
 * (src/visionCamera.js) so this page and the Conductor Panel always show the
 * same feed and the same passenger count - and never compete for the camera.
 */

import {
  CameraStatus,
  ModelStatus,
  attachVideo,
  checkBackendModelStatus,
  getActiveBusId,
  getState,
  isCameraActive,
  postHeartbeat,
  refreshCameraDevices,
  registerConsumer,
  restartCamera,
  setActiveBusId,
  startCamera,
  stopCamera,
  subscribe
} from "./visionCamera.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function relativeTime(value) {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

let unsubscribe = null;
let releaseConsumer = null;
let registeredBuses = [];

/* ------------------------------------------------------------------ */
/* Backend data                                                        */
/* ------------------------------------------------------------------ */

async function loadRegisteredBuses() {
  try {
    const res = await fetch("/api/conductor/buses");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.buses) && data.buses.length) {
      registeredBuses = data.buses;
      populateBusSelect();
    }
  } catch (err) {
    console.warn("Could not load registered buses:", err);
  }
}

function populateBusSelect() {
  const select = document.getElementById("cvBusSelect");
  if (!select || !registeredBuses.length) return;
  let active = getActiveBusId();
  // The shared active bus must exist in the backend fleet. If it does not,
  // adopt the first registered bus so detections are published to a bus the
  // Conductor Panel can actually poll.
  if (!registeredBuses.some((bus) => bus.id === active)) {
    active = registeredBuses[0].id;
    setActiveBusId(active);
  }
  select.innerHTML = registeredBuses
    .map((bus) => `<option value="${esc(bus.id)}"${bus.id === active ? " selected" : ""}>${esc(bus.id)} · ${esc(bus.route)}</option>`)
    .join("");
  select.value = active;
}

function populateCameraDeviceSelect(devices) {
  const select = document.getElementById("cvCameraSelect");
  if (!select) return;
  const current = getState().selectedDeviceId;
  if (!devices.length) {
    select.innerHTML = `<option value="">Default Browser Camera</option>`;
    return;
  }
  select.innerHTML = devices
    .map(
      (dev, idx) =>
        `<option value="${esc(dev.deviceId)}"${dev.deviceId === current ? " selected" : ""}>${esc(dev.label || `Camera ${idx + 1}`)}</option>`
    )
    .join("");
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderComputerVision() {
  return `
    <div class="cv-page-container">
      <!-- Page Heading -->
      <div class="page-heading">
        <div>
          <h1>Computer Vision Monitoring</h1>
          <p>Real-time browser camera stream with YOLO person detection and passenger counting.</p>
        </div>
        <div class="heading-actions">
          <span class="demo-tag">DEMO ENVIRONMENT</span>
        </div>
      </div>

      <!-- Top Summary Grid: Single Prominent Counter & Camera Status -->
      <div class="cv-hero-grid">
        <article class="kpi-card cv-people-card">
          <div class="kpi-top">
            <span class="kpi-label">PEOPLE DETECTED</span>
            <span class="kpi-icon teal">👥</span>
          </div>
          <div class="cv-people-value" id="cvPeopleCount">—</div>
          <div class="kpi-foot" id="cvPeopleFoot">Start camera to monitor</div>
        </article>

        <article class="kpi-card cv-status-card">
          <div class="kpi-top">
            <span class="kpi-label">CAMERA STATUS</span>
            <span class="kpi-icon">📷</span>
          </div>
          <div class="cv-status-badge-wrap">
            <span id="cvCameraStatusBadge" class="status status-reviewed">Camera Off</span>
          </div>
          <div class="kpi-foot" id="cvCameraStatusFoot">Webcam standby</div>
        </article>

        <article class="kpi-card cv-status-card">
          <div class="kpi-top">
            <span class="kpi-label">DETECTION MODEL</span>
            <span class="kpi-icon teal">🧠</span>
          </div>
          <div class="cv-status-badge-wrap">
            <span id="cvModelStatusBadge" class="status status-pending">Loading Model</span>
          </div>
          <div class="kpi-foot" id="cvModelStatusFoot">YOLO · person class</div>
        </article>
      </div>

      <!-- Error Notice Banner -->
      <div id="cvErrorBanner" class="cv-error-banner" style="display:none"></div>

      <!-- Unified Camera Controls Bar -->
      <div class="cv-controls-bar">
        <div class="cv-controls-left">
          <button class="btn btn-primary" id="cvStartBtn">
            ▶ Allow Camera &amp; Start Monitoring
          </button>
          <button class="btn btn-danger" id="cvStopBtn" disabled>
            ■ Stop Camera
          </button>
          <button class="btn" id="cvRestartBtn" disabled>
            ↻ Restart Camera
          </button>
        </div>
        <div class="cv-controls-right">
          <label class="cv-field">
            <span>Bus</span>
            <select id="cvBusSelect" class="form-control cv-select-device" aria-label="Bus monitored by this camera"></select>
          </label>
          <label class="cv-field">
            <span>Camera</span>
            <select id="cvCameraSelect" class="form-control cv-select-device" aria-label="Camera device"></select>
          </label>
          <button class="btn" data-goto="Conductor Panel">
            🎫 Conductor Panel →
          </button>
        </div>
      </div>

      <!-- Large Live Browser Camera Preview -->
      <section class="panel cv-preview-panel">
        <div class="cv-viewport-wrap" id="cvPreviewContainer">
          <video id="cvVideoElement" class="cv-video" playsinline muted autoplay></video>
          <canvas id="cvOverlayCanvas" class="cv-canvas"></canvas>

          <div id="cvPlaceholder" class="cv-placeholder">
            <div class="cv-placeholder-card">
              <div class="cv-cam-glyph">📷</div>
              <h3>Browser Camera Off</h3>
              <p>Click <strong>Allow Camera &amp; Start Monitoring</strong> above to begin real-time YOLO person detection.</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* Status rendering                                                    */
/* ------------------------------------------------------------------ */

function cameraBadge(state) {
  if (state.cameraStatus === CameraStatus.CONNECTED) return { cls: "status status-normal", text: "Camera Active" };
  if (state.cameraStatus === CameraStatus.CONNECTING) return { cls: "status status-pending", text: "Requesting Permission" };
  if (state.cameraStatus === CameraStatus.PERMISSION_DENIED) return { cls: "status status-mismatch", text: "Permission Denied" };
  if (state.cameraStatus === CameraStatus.UNAVAILABLE) return { cls: "status status-mismatch", text: "Camera Unavailable" };
  if (state.cameraStatus === CameraStatus.ERROR) return { cls: "status status-mismatch", text: "Error" };
  return { cls: "status status-reviewed", text: "Camera Off" };
}

function renderStatusUi(state) {
  const placeholderEl = document.getElementById("cvPlaceholder");
  const cameraBadgeEl = document.getElementById("cvCameraStatusBadge");
  const modelBadge = document.getElementById("cvModelStatusBadge");
  const startBtn = document.getElementById("cvStartBtn");
  const stopBtn = document.getElementById("cvStopBtn");
  const restartBtn = document.getElementById("cvRestartBtn");
  const errorBanner = document.getElementById("cvErrorBanner");
  const peopleCountEl = document.getElementById("cvPeopleCount");
  const peopleFootEl = document.getElementById("cvPeopleFoot");
  const cameraFootEl = document.getElementById("cvCameraStatusFoot");
  const modelFootEl = document.getElementById("cvModelStatusFoot");

  const streaming = state.cameraStatus === CameraStatus.CONNECTED && !!state.stream;

  if (placeholderEl) placeholderEl.style.display = streaming ? "none" : "flex";

  if (cameraBadgeEl) {
    const badge = cameraBadge(state);
    cameraBadgeEl.className = badge.cls;
    cameraBadgeEl.textContent = badge.text;
  }

  if (cameraFootEl) {
    if (state.cameraStatus === CameraStatus.CONNECTED) cameraFootEl.textContent = "Streaming live video";
    else if (state.cameraStatus === CameraStatus.CONNECTING) cameraFootEl.textContent = "Awaiting user approval";
    else if (state.cameraStatus === CameraStatus.PERMISSION_DENIED) cameraFootEl.textContent = "Allow camera in the browser";
    else if (state.cameraStatus === CameraStatus.UNAVAILABLE) cameraFootEl.textContent = "No camera / unsupported browser";
    else if (state.cameraStatus === CameraStatus.ERROR) cameraFootEl.textContent = "Check permissions/hardware";
    else cameraFootEl.textContent = "Webcam standby";
  }

  if (modelBadge) {
    if (state.modelStatus === ModelStatus.READY) {
      modelBadge.className = "status status-normal";
      modelBadge.textContent = "Model Ready";
    } else if (state.modelStatus === ModelStatus.ERROR) {
      modelBadge.className = "status status-mismatch";
      modelBadge.textContent = "Model Error";
    } else {
      modelBadge.className = "status status-pending";
      modelBadge.textContent = "Loading Model";
    }
  }

  if (modelFootEl) {
    if (state.modelStatus === ModelStatus.ERROR) {
      modelFootEl.textContent = "Backend model unavailable";
    } else if (state.lastInferenceMs !== null && state.lastInferenceMs !== undefined) {
      modelFootEl.textContent = `YOLOv8 person · ${Math.round(state.lastInferenceMs)} ms/frame`;
    } else {
      modelFootEl.textContent = "YOLO · person class";
    }
  }

  const hasCount = state.lastCount !== null && state.lastCount !== undefined;
  if (peopleCountEl) {
    peopleCountEl.textContent = hasCount ? String(state.lastCount) : "—";
  }

  if (peopleFootEl) {
    if (!streaming) {
      peopleFootEl.textContent = "Start camera to monitor";
    } else if (!hasCount) {
      peopleFootEl.textContent = "Waiting for first detection…";
    } else {
      const updated = relativeTime(state.lastDetectionAt);
      peopleFootEl.textContent = updated ? `Live current-frame count · ${updated}` : "Live current-frame count";
    }
  }

  const isRequesting = state.cameraStatus === CameraStatus.CONNECTING;
  if (startBtn) {
    startBtn.disabled = streaming || isRequesting;
    startBtn.innerHTML = isRequesting ? "⏳ Requesting Permission..." : "▶ Allow Camera &amp; Start Monitoring";
  }
  if (stopBtn) stopBtn.disabled = !streaming;
  if (restartBtn) restartBtn.disabled = state.cameraStatus === CameraStatus.IDLE || isRequesting;

  if (errorBanner) {
    const showError =
      !!state.errorMessage &&
      (state.cameraStatus !== CameraStatus.CONNECTED || state.modelStatus === ModelStatus.ERROR);
    if (showError) {
      const title = state.cameraStatus === CameraStatus.CONNECTED ? "Detection Notice" : "Camera Notice";
      errorBanner.style.display = "block";
      errorBanner.innerHTML = `
        <div class="cv-alert-box">
          <span class="cv-alert-icon">⚠</span>
          <div class="cv-alert-body">
            <strong>${title}</strong>
            <p>${esc(state.errorMessage)}</p>
          </div>
          <button class="btn btn-small" id="cvDismissAlert">Dismiss</button>
        </div>
      `;
      document.getElementById("cvDismissAlert")?.addEventListener("click", () => {
        state.errorMessage = "";
        errorBanner.style.display = "none";
      });
    } else {
      errorBanner.style.display = "none";
    }
  }

  // Attach the shared stream to the visible video element
  const videoEl = document.getElementById("cvVideoElement");
  if (videoEl) {
    if (streaming) {
      attachVideo(videoEl);
      adjustCanvasSize();
      drawBoundingBoxes(state.lastDetections, state.lastFrameSize);
    } else if (videoEl.srcObject) {
      videoEl.srcObject = null;
    }
  }

  populateCameraDeviceSelect(state.devices);
}

/* ------------------------------------------------------------------ */
/* Bounding boxes                                                      */
/* ------------------------------------------------------------------ */

function drawBoundingBoxes(detections, frameSize) {
  const videoEl = document.getElementById("cvVideoElement");
  const canvasEl = document.getElementById("cvOverlayCanvas");
  if (!videoEl || !canvasEl) return;

  const ctx = canvasEl.getContext("2d");
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (!detections || detections.length === 0) return;

  const origW = frameSize?.width || videoEl.videoWidth || canvasEl.width;
  const origH = frameSize?.height || videoEl.videoHeight || canvasEl.height;
  const canvasW = canvasEl.width;
  const canvasH = canvasEl.height;
  const vw = videoEl.videoWidth || origW;
  const vh = videoEl.videoHeight || origH;

  const videoRatio = vw / vh;
  const containerRatio = canvasW / canvasH;
  let renderW;
  let renderH;
  let offsetX;
  let offsetY;

  if (containerRatio > videoRatio) {
    renderH = canvasH;
    renderW = canvasH * videoRatio;
    offsetX = (canvasW - renderW) / 2;
    offsetY = 0;
  } else {
    renderW = canvasW;
    renderH = canvasW / videoRatio;
    offsetX = 0;
    offsetY = (canvasH - renderH) / 2;
  }

  const scaleX = renderW / (origW || vw);
  const scaleY = renderH / (origH || vh);

  detections.forEach((det, i) => {
    const rawX1 = det.x1 !== undefined ? det.x1 : det.box[0];
    const rawY1 = det.y1 !== undefined ? det.y1 : det.box[1];
    const rawX2 = det.x2 !== undefined ? det.x2 : det.box[2];
    const rawY2 = det.y2 !== undefined ? det.y2 : det.box[3];

    const x1 = offsetX + rawX1 * scaleX;
    const y1 = offsetY + rawY1 * scaleY;
    const x2 = offsetX + rawX2 * scaleX;
    const y2 = offsetY + rawY2 * scaleY;
    const w = x2 - x1;
    const h = y2 - y1;

    const color = "#2864dc";
    const cornerColor = "#ffffff";

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.fillStyle = "rgba(40, 100, 220, 0.12)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x1, y1, w, h, 6);
    else ctx.rect(x1, y1, w, h);
    ctx.fill();
    ctx.stroke();

    const cornerSize = Math.min(18, Math.max(8, w / 4), Math.max(8, h / 4));
    ctx.strokeStyle = cornerColor;
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(x1, y1 + cornerSize);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1 + cornerSize, y1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2 - cornerSize, y1);
    ctx.lineTo(x2, y1);
    ctx.lineTo(x2, y1 + cornerSize);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x1, y2 - cornerSize);
    ctx.lineTo(x1, y2);
    ctx.lineTo(x1 + cornerSize, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2 - cornerSize, y2);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - cornerSize, y2);
    ctx.stroke();

    const labelText = `Person ${i + 1}`;
    ctx.font = "bold 11px Manrope, 'DM Sans', sans-serif";
    const textWidth = ctx.measureText(labelText).width;
    const badgeH = 20;
    const badgeW = textWidth + 14;
    const badgeY = Math.max(offsetY, y1 - badgeH - 4);

    ctx.fillStyle = color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x1, badgeY, badgeW, badgeH, 4);
    else ctx.rect(x1, badgeY, badgeW, badgeH);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.fillText(labelText, x1 + 7, badgeY + 14);
    ctx.restore();
  });
}

function adjustCanvasSize() {
  const videoEl = document.getElementById("cvVideoElement");
  const canvasEl = document.getElementById("cvOverlayCanvas");
  if (!videoEl || !canvasEl) return;
  const rect = videoEl.getBoundingClientRect();
  const targetW = Math.round(rect.width);
  const targetH = Math.round(rect.height);
  if (targetW > 0 && targetH > 0 && (canvasEl.width !== targetW || canvasEl.height !== targetH)) {
    canvasEl.width = targetW;
    canvasEl.height = targetH;
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

export function wireComputerVisionControls() {
  checkBackendModelStatus();
  refreshCameraDevices();
  loadRegisteredBuses();

  releaseConsumer = registerConsumer("computer-vision");
  unsubscribe = subscribe(renderStatusUi);

  // Reuse a camera session that is already running (started on the panel)
  if (isCameraActive()) {
    attachVideo(document.getElementById("cvVideoElement"));
  }

  document.getElementById("cvStartBtn")?.addEventListener("click", () => startCamera(getState().selectedDeviceId));
  document.getElementById("cvStopBtn")?.addEventListener("click", () => stopCamera());
  document.getElementById("cvRestartBtn")?.addEventListener("click", () => restartCamera());

  document.getElementById("cvCameraSelect")?.addEventListener("change", (e) => {
    const deviceId = e.target.value;
    const current = getState();
    current.selectedDeviceId = deviceId;
    if (isCameraActive()) startCamera(deviceId);
  });

  document.getElementById("cvBusSelect")?.addEventListener("change", (e) => {
    setActiveBusId(e.target.value);
    postHeartbeat("bus_selected");
  });

  window.addEventListener("resize", adjustCanvasSize);

  // Global cleanup hook used by the page router.
  window.__stopVisionMonitoring = () => {
    // The shared camera session is only released when no other page needs it.
    if (releaseConsumer) releaseConsumer();
    releaseConsumer = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    postHeartbeat("page_closed");
  };
}
