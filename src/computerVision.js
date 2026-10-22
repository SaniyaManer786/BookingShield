/**
 * SMART ST Control Center - Computer Vision Monitoring Module
 * Real-time browser camera stream capture & YOLOv8 person detection with OpenCV processing
 */

// Module state
let activeStream = null;
let inferenceTimer = null;
let isProcessingFrame = false;

// Statuses strictly following specifications:
// Camera Status: 'Camera Off' | 'Requesting Permission' | 'Camera Active' | 'Error'
let cameraStatus = "Camera Off";

// Model Status: 'Loading Model' | 'Model Ready' | 'Model Error'
let modelStatus = "Loading Model";

let errorMessage = "";
let selectedDeviceId = "";
let videoDevices = [];
let currentFramePeopleCount = null; // null represents "—" before camera starts
const inferenceIntervalMs = 300; // Optimal balance for real-time responsiveness and CPU conservation

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Checks backend health and YOLO model readiness via /api/health
 */
export async function checkBackendModelStatus() {
  modelStatus = "Loading Model";
  renderStatusUi();

  try {
    const res = await fetch("/api/health");
    if (res.ok) {
      const data = await res.json();
      if (data.status === "healthy" || data.model_loaded === true) {
        modelStatus = "Model Ready";
      } else {
        modelStatus = "Model Error";
      }
    } else {
      modelStatus = "Model Error";
    }
  } catch (err) {
    console.warn("Could not reach backend health check:", err);
    modelStatus = "Model Error";
  }

  renderStatusUi();
}

/**
 * Enumerates all available video input devices (webcams)
 */
export async function refreshCameraDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter((d) => d.kind === "videoinput");
    populateCameraDropdown();
  } catch (err) {
    console.warn("Could not enumerate media devices:", err);
  }
}

function populateCameraDropdown() {
  const select = document.getElementById("cvCameraSelect");
  if (!select) return;
  select.innerHTML = "";

  if (videoDevices.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Default Browser Camera";
    select.appendChild(opt);
    return;
  }

  videoDevices.forEach((dev, idx) => {
    const opt = document.createElement("option");
    opt.value = dev.deviceId;
    opt.textContent = dev.label || `Camera ${idx + 1} (${dev.deviceId.slice(0, 8)}...)`;
    if (dev.deviceId === selectedDeviceId) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

/**
 * Starts the webcam stream via navigator.mediaDevices.getUserMedia()
 */
export async function startCamera(deviceId = "") {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraStatus = "Error";
    errorMessage = "Camera access is not supported by this browser or secure context (HTTPS or localhost is required).";
    renderStatusUi();
    return;
  }

  cameraStatus = "Requesting Permission";
  errorMessage = "";
  renderStatusUi();

  // Stop any active stream tracks first
  stopCameraTracks();

  const constraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    activeStream = stream;
    cameraStatus = "Camera Active";
    errorMessage = "";

    const videoEl = document.getElementById("cvVideoElement");
    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl.onloadedmetadata = () => {
        videoEl.play().catch((e) => console.warn("Video play error:", e));
        adjustCanvasSize();
        startInferenceLoop();
      };
    }

    // Refresh devices once permission is granted so human-readable labels appear
    await refreshCameraDevices();
    renderStatusUi();
  } catch (err) {
    console.error("Camera access error:", err);
    activeStream = null;
    cameraStatus = "Error";

    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      errorMessage = "Camera permission denied. Please allow camera access in your browser address bar and click Restart Camera.";
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      errorMessage = "No camera detected on this computer. Please connect a webcam and click Restart Camera.";
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      errorMessage = "Camera is currently in use by another application. Please close other camera apps and click Restart Camera.";
    } else if (err.name === "OverconstrainedError") {
      errorMessage = "Requested camera constraint or resolution is not supported by your hardware.";
    } else {
      errorMessage = `Camera error: ${err.message || err.name}`;
    }

    renderStatusUi();
  }
}

/**
 * Stops all camera tracks, clears preview, and halts inference
 */
export function stopCamera() {
  stopInferenceLoop();
  stopCameraTracks();
  cameraStatus = "Camera Off";
  currentFramePeopleCount = null;

  const videoEl = document.getElementById("cvVideoElement");
  if (videoEl) {
    videoEl.srcObject = null;
  }

  const canvasEl = document.getElementById("cvOverlayCanvas");
  if (canvasEl) {
    const ctx = canvasEl.getContext("2d");
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  }

  renderStatusUi();
}

function stopCameraTracks() {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (e) {
        console.warn("Error stopping track:", e);
      }
    });
    activeStream = null;
  }
}

/**
 * Restarts the camera stream
 */
export function restartCamera() {
  stopCamera();
  setTimeout(() => {
    startCamera(selectedDeviceId);
  }, 250);
}

/**
 * Inference loop: Captures current frames and sends to backend YOLO
 */
function startInferenceLoop() {
  stopInferenceLoop();
  scheduleNextFrame();
}

function stopInferenceLoop() {
  if (inferenceTimer) {
    clearTimeout(inferenceTimer);
    inferenceTimer = null;
  }
  isProcessingFrame = false;
}

function scheduleNextFrame() {
  if (!activeStream || cameraStatus !== "Camera Active") return;
  inferenceTimer = setTimeout(async () => {
    await processVideoFrame();
    scheduleNextFrame();
  }, inferenceIntervalMs);
}

/**
 * Captures the current video frame and sends it to the backend for YOLO detection.
 * Confidence threshold is strictly configured and enforced in the backend.
 */
async function processVideoFrame() {
  const videoEl = document.getElementById("cvVideoElement");
  const canvasEl = document.getElementById("cvOverlayCanvas");
  if (!videoEl || !canvasEl || videoEl.readyState < 2 || isProcessingFrame) return;

  isProcessingFrame = true;

  try {
    adjustCanvasSize();

    // Capture current frame onto offscreen canvas
    const offscreen = document.createElement("canvas");
    const captureW = videoEl.videoWidth || 640;
    const captureH = videoEl.videoHeight || 480;
    offscreen.width = captureW;
    offscreen.height = captureH;
    const offCtx = offscreen.getContext("2d");
    offCtx.drawImage(videoEl, 0, 0, captureW, captureH);

    // Compress to JPEG for high-performance low-latency inference
    const base64Jpeg = offscreen.toDataURL("image/jpeg", 0.75);

    // Send to backend (confidence threshold is handled on backend)
    const activeBusId = window.__activeMonitoringBusId || "MH-12-QW-4821";
    const res = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: base64Jpeg,
        bus_id: activeBusId
      })
    });

    if (res.ok) {
      const data = await res.json();
      modelStatus = "Model Ready";
      handleDetectionResult(data);
    } else {
      modelStatus = "Model Error";
      console.warn("Detection returned error status:", res.status);
    }
  } catch (err) {
    modelStatus = "Model Error";
    console.error("Frame processing error:", err);
  } finally {
    isProcessingFrame = false;
    renderStatusUi();
  }
}

/**
 * Handles detection result from backend YOLO
 */
function handleDetectionResult(result) {
  const detections = result.detections || [];
  
  // The displayed count strictly equals the number of valid person detections returned
  currentFramePeopleCount = detections.length;

  const counterEl = document.getElementById("cvPeopleCount");
  if (counterEl) {
    counterEl.textContent = String(currentFramePeopleCount);
  }

  // Draw YOLO person detection bounding boxes
  drawBoundingBoxes(detections, result.image_width, result.image_height);
}

/**
 * Draws YOLO person detection bounding boxes over the video stream with coordinate scaling
 */
function drawBoundingBoxes(detections, origW, origH) {
  const videoEl = document.getElementById("cvVideoElement");
  const canvasEl = document.getElementById("cvOverlayCanvas");
  if (!videoEl || !canvasEl) return;

  const ctx = canvasEl.getContext("2d");
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  if (!detections || detections.length === 0) return;

  const canvasW = canvasEl.width;
  const canvasH = canvasEl.height;
  const vw = videoEl.videoWidth || origW || canvasW;
  const vh = videoEl.videoHeight || origH || canvasH;

  // Compute exact position and dimensions of the video rendered inside the canvas (handling object-fit: contain)
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

    const color = "#2864dc"; // SMART ST primary blue
    const cornerColor = "#ffffff";

    ctx.save();

    // 1. Semi-transparent fill and bounding rectangle
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.fillStyle = "rgba(40, 100, 220, 0.12)";
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x1, y1, w, h, 6);
    } else {
      ctx.rect(x1, y1, w, h);
    }
    ctx.fill();
    ctx.stroke();

    // 2. High-contrast corner brackets for crisp perception
    const cornerSize = Math.min(18, Math.max(8, w / 4), Math.max(8, h / 4));
    ctx.strokeStyle = cornerColor;
    ctx.lineWidth = 3;

    // Top-left corner
    ctx.beginPath();
    ctx.moveTo(x1, y1 + cornerSize);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1 + cornerSize, y1);
    ctx.stroke();

    // Top-right corner
    ctx.beginPath();
    ctx.moveTo(x2 - cornerSize, y1);
    ctx.lineTo(x2, y1);
    ctx.lineTo(x2, y1 + cornerSize);
    ctx.stroke();

    // Bottom-left corner
    ctx.beginPath();
    ctx.moveTo(x1, y2 - cornerSize);
    ctx.lineTo(x1, y2);
    ctx.lineTo(x1 + cornerSize, y2);
    ctx.stroke();

    // Bottom-right corner
    ctx.beginPath();
    ctx.moveTo(x2 - cornerSize, y2);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2, y2 - cornerSize);
    ctx.stroke();

    // 3. Clean "Person" label pill badge
    const labelText = `Person ${i + 1}`;
    ctx.font = "bold 11px Manrope, 'DM Sans', sans-serif";
    const textWidth = ctx.measureText(labelText).width;
    const badgeH = 20;
    const badgeW = textWidth + 14;
    const badgeY = Math.max(offsetY, y1 - badgeH - 4);

    ctx.fillStyle = color;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x1, badgeY, badgeW, badgeH, 4);
    } else {
      ctx.rect(x1, badgeY, badgeW, badgeH);
    }
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

/**
 * Updates UI statuses, badges, and controls
 */
function renderStatusUi() {
  const placeholderEl = document.getElementById("cvPlaceholder");
  const cameraBadge = document.getElementById("cvCameraStatusBadge");
  const modelBadge = document.getElementById("cvModelStatusBadge");
  const startBtn = document.getElementById("cvStartBtn");
  const stopBtn = document.getElementById("cvStopBtn");
  const restartBtn = document.getElementById("cvRestartBtn");
  const errorBanner = document.getElementById("cvErrorBanner");
  const peopleCountEl = document.getElementById("cvPeopleCount");
  const peopleFootEl = document.getElementById("cvPeopleFoot");
  const cameraFootEl = document.getElementById("cvCameraStatusFoot");

  const isStreaming = cameraStatus === "Camera Active" && activeStream !== null;

  // Placeholder visibility
  if (placeholderEl) {
    placeholderEl.style.display = isStreaming ? "none" : "flex";
  }

  // Camera Status Badge: Camera Off | Requesting Permission | Camera Active | Error
  if (cameraBadge) {
    if (cameraStatus === "Camera Active") {
      cameraBadge.className = "status status-normal";
      cameraBadge.textContent = "Camera Active";
    } else if (cameraStatus === "Requesting Permission") {
      cameraBadge.className = "status status-pending";
      cameraBadge.textContent = "Requesting Permission";
    } else if (cameraStatus === "Error") {
      cameraBadge.className = "status status-mismatch";
      cameraBadge.textContent = "Error";
    } else {
      cameraBadge.className = "status status-reviewed";
      cameraBadge.textContent = "Camera Off";
    }
  }

  if (cameraFootEl) {
    if (cameraStatus === "Camera Active") {
      cameraFootEl.textContent = "Streaming live video";
    } else if (cameraStatus === "Requesting Permission") {
      cameraFootEl.textContent = "Awaiting user approval";
    } else if (cameraStatus === "Error") {
      cameraFootEl.textContent = "Check permissions/hardware";
    } else {
      cameraFootEl.textContent = "Webcam standby";
    }
  }

  // Model Status Badge: Loading Model | Model Ready | Model Error
  if (modelBadge) {
    if (modelStatus === "Model Ready") {
      modelBadge.className = "status status-normal";
      modelBadge.textContent = "Model Ready";
    } else if (modelStatus === "Model Error") {
      modelBadge.className = "status status-mismatch";
      modelBadge.textContent = "Model Error";
    } else {
      modelBadge.className = "status status-pending";
      modelBadge.textContent = "Loading Model";
    }
  }

  // People Detected Counter
  if (peopleCountEl) {
    if (currentFramePeopleCount === null) {
      peopleCountEl.textContent = "—";
    } else {
      peopleCountEl.textContent = String(currentFramePeopleCount);
    }
  }

  if (peopleFootEl) {
    if (cameraStatus === "Camera Active") {
      peopleFootEl.textContent = "Current frame YOLO count";
    } else {
      peopleFootEl.textContent = "Start camera to monitor";
    }
  }

  // Buttons state
  const isRequesting = cameraStatus === "Requesting Permission";

  if (startBtn) {
    startBtn.disabled = isStreaming || isRequesting;
    startBtn.innerHTML = isRequesting ? "⏳ Requesting Permission..." : "▶ Allow Camera &amp; Start Monitoring";
  }

  if (stopBtn) {
    stopBtn.disabled = !isStreaming;
  }

  if (restartBtn) {
    restartBtn.disabled = cameraStatus === "Camera Off" || isRequesting;
  }

  // Error Banner
  if (errorBanner) {
    if (errorMessage && cameraStatus === "Error") {
      errorBanner.style.display = "block";
      errorBanner.innerHTML = `
        <div class="cv-alert-box">
          <span class="cv-alert-icon">⚠</span>
          <div class="cv-alert-body">
            <strong>Camera Notice</strong>
            <p>${esc(errorMessage)}</p>
          </div>
          <button class="btn btn-small" id="cvDismissAlert">Dismiss</button>
        </div>
      `;
      document.getElementById("cvDismissAlert")?.addEventListener("click", () => {
        errorMessage = "";
        errorBanner.style.display = "none";
      });
    } else {
      errorBanner.style.display = "none";
    }
  }
}

/**
 * Main Page HTML Renderer for Computer Vision Monitoring
 * Clean, minimal, responsive, single start button, and suitable for classroom demonstration.
 */
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
        <!-- Single Prominent People Detected Counter -->
        <article class="kpi-card cv-people-card">
          <div class="kpi-top">
            <span class="kpi-label">PEOPLE DETECTED</span>
            <span class="kpi-icon teal">👥</span>
          </div>
          <div class="cv-people-value" id="cvPeopleCount">—</div>
          <div class="kpi-foot" id="cvPeopleFoot">Start camera to monitor</div>
        </article>

        <!-- Camera Status -->
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
      </div>

      <!-- Error Notice Banner -->
      <div id="cvErrorBanner" class="cv-error-banner" style="display:none"></div>

      <!-- Single Unified Camera Controls Bar -->
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

          <!-- Placeholder before camera starts -->
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

/**
 * Attaches all event listeners for the Computer Vision page
 */
export function wireComputerVisionControls() {
  checkBackendModelStatus();
  refreshCameraDevices();
  renderStatusUi();

  // Expose global cleanup so navigating away stops camera tracks immediately
  window.__stopVisionMonitoring = stopCamera;

  // Single unified start action
  document.getElementById("cvStartBtn")?.addEventListener("click", () => startCamera(selectedDeviceId));

  // Stop & Restart handlers
  document.getElementById("cvStopBtn")?.addEventListener("click", stopCamera);
  document.getElementById("cvRestartBtn")?.addEventListener("click", restartCamera);

  // Camera selection dropdown
  document.getElementById("cvCameraSelect")?.addEventListener("change", (e) => {
    selectedDeviceId = e.target.value;
    if (activeStream) {
      startCamera(selectedDeviceId);
    }
  });

  // Responsive canvas resize listener
  window.addEventListener("resize", adjustCanvasSize);

  // Stop camera if user leaves or refreshes
  window.addEventListener("beforeunload", stopCamera);
  window.addEventListener("pagehide", stopCamera);
}
