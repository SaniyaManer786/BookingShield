/**
 * SMART ST Control Center - Shared Vision Camera Service
 *
 * Single owner of the browser camera and of the OpenCV/YOLO inference loop.
 *
 * Why this module exists:
 *  - The Computer Vision Monitoring page and the Conductor Panel must show the
 *    SAME camera feed and the SAME passenger count.
 *  - Two pages must never open a competing getUserMedia() stream or run a second
 *    inference loop for the same camera.
 *
 * The service therefore keeps:
 *  - exactly one MediaStream (shared by every attached <video> element),
 *  - exactly one inference loop that posts frames to POST /api/detect,
 *  - exactly one "active bus" so both pages count for the same bus,
 *  - a camera session heartbeat (POST /api/vision/session) so the backend knows
 *    the real camera state (connecting / permission denied / model error / ...).
 *
 * The passenger count itself is produced by the real backend OpenCV/YOLO
 * pipeline and stored by the backend. The Conductor Panel reads it back through
 * GET /api/conductor/camera-state, so the number is never invented locally.
 */

export const CameraStatus = {
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  PERMISSION_DENIED: "permission_denied",
  UNAVAILABLE: "unavailable",
  ERROR: "error"
};

export const ModelStatus = {
  LOADING: "loading",
  READY: "ready",
  ERROR: "error"
};

const API_DETECT = "/api/detect";
const API_SESSION = "/api/vision/session";
const API_RESET_TRACKER = "/api/reset-tracker";
// Frames are sent one at a time; this is only the idle gap between two
// completed inferences, so the loop keeps up with the CPU without queueing.
const INFERENCE_INTERVAL_MS = 60;
// Uploading 1280x720 frames costs bandwidth and client CPU for no accuracy
// gain: the backend resizes to the model input size anyway.
const MAX_CAPTURE_WIDTH = 640;
const HEARTBEAT_INTERVAL_MS = 15000;

const state = {
  busId: "MH-12-QW-4821",
  stream: null,
  cameraStatus: CameraStatus.IDLE,
  modelStatus: ModelStatus.LOADING,
  errorMessage: "",
  lastCount: null,
  lastDetections: [],
  lastDetectionAt: null,
  lastFrameSize: null,
  devices: [],
  selectedDeviceId: "",
  sessionId: "",
  processing: false,
  lastInferenceMs: null,
  // Incremented for every camera session. In-flight detection responses from a
  // previous session (stopped camera, restarted camera) are discarded.
  sessionEpoch: 0
};

const listeners = new Set();
const consumers = new Set();

let inferenceTimer = null;
let inferenceAbort = null;
let heartbeatTimer = null;
let captureVideo = null;
let autoStopTimer = null;

/* ------------------------------------------------------------------ */
/* Store plumbing                                                      */
/* ------------------------------------------------------------------ */

export function subscribe(listener) {
  listeners.add(listener);
  try {
    listener(getState());
  } catch (err) {
    console.warn("Vision camera listener failed:", err);
  }
  return () => listeners.delete(listener);
}

export function getState() {
  return { ...state, devices: [...state.devices] };
}

function notify() {
  const snapshot = getState();
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (err) {
      console.warn("Vision camera listener failed:", err);
    }
  });
}

function setState(patch) {
  Object.assign(state, patch);
  notify();
}

/* ------------------------------------------------------------------ */
/* Page consumers - used to decide when the camera may be released      */
/* ------------------------------------------------------------------ */

/**
 * Registers a page that needs the shared camera session.
 *
 * The camera is released only when the last consumer unregisters. The stop is
 * deferred by one tick so a page-to-page navigation (for example Computer
 * Vision -> Conductor Panel) can hand the session over without stopping and
 * restarting the webcam.
 */
export function registerConsumer(name) {
  consumers.add(name);
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  return () => {
    consumers.delete(name);
    scheduleAutoStop();
  };
}

export function consumerCount() {
  return consumers.size;
}

function scheduleAutoStop() {
  if (autoStopTimer) clearTimeout(autoStopTimer);
  autoStopTimer = setTimeout(() => {
    autoStopTimer = null;
    if (consumers.size === 0 && state.cameraStatus !== CameraStatus.IDLE) {
      stopCamera();
    }
  }, 0);
}

/* ------------------------------------------------------------------ */
/* Active bus (shared between the monitoring page and the panel)        */
/* ------------------------------------------------------------------ */

export function getActiveBusId() {
  return state.busId;
}

export function setActiveBusId(busId) {
  const next = (busId || "").trim().toUpperCase();
  if (!next || next === state.busId) return;
  // The count belongs to the previously selected bus. Drop it immediately so
  // the panel never shows one bus's passengers under another bus's number.
  setState({
    busId: next,
    lastCount: null,
    lastDetections: [],
    lastDetectionAt: null,
    lastFrameSize: null
  });
  if (typeof window !== "undefined") {
    window.__activeMonitoringBusId = next;
  }
  // A different bus is a different camera scene: old ByteTrack IDs would let a
  // passenger from the previous scene suppress a new detection.
  if (isCameraActive()) resetBackendTracker();
  postHeartbeat("active_bus_changed");
}

/* ------------------------------------------------------------------ */
/* Camera devices                                                      */
/* ------------------------------------------------------------------ */

export async function refreshCameraDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videos = devices.filter((d) => d.kind === "videoinput");
    setState({ devices: videos });
    return videos;
  } catch (err) {
    console.warn("Could not enumerate media devices:", err);
    return state.devices;
  }
}

/* ------------------------------------------------------------------ */
/* Camera lifecycle                                                    */
/* ------------------------------------------------------------------ */

export function isCameraActive() {
  return state.cameraStatus === CameraStatus.CONNECTED && !!state.stream;
}

/**
 * Starts the camera. Safe to call from several pages: when a stream already
 * exists the existing stream is reused instead of requesting a second one.
 */
export async function startCamera(deviceId = "") {
  if (state.cameraStatus === CameraStatus.CONNECTING) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setState({
      cameraStatus: CameraStatus.UNAVAILABLE,
      errorMessage: "Camera access is not supported by this browser or secure context (HTTPS or localhost is required)."
    });
    postHeartbeat("unsupported_browser");
    return;
  }

  // Reuse the running stream - never open a competing camera.
  if (state.stream && state.stream.active && !deviceId) {
    setState({ cameraStatus: CameraStatus.CONNECTED });
    return;
  }

  setState({ cameraStatus: CameraStatus.CONNECTING, errorMessage: "" });
  postHeartbeat("connecting");

  stopTracks();

  const epoch = ++state.sessionEpoch;

  const constraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Another start/stop happened while the permission prompt was open.
    if (epoch !== state.sessionEpoch) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    state.sessionId = `CV-${Date.now().toString(36).toUpperCase()}`;
    setState({
      stream,
      cameraStatus: CameraStatus.CONNECTED,
      errorMessage: "",
      lastCount: null,
      lastDetections: [],
      lastDetectionAt: null,
      lastInferenceMs: null
    });

    watchStreamEnd(stream, epoch);

    await attachCaptureStream(stream);
    await refreshCameraDevices();

    setState({ selectedDeviceId: deviceId || state.selectedDeviceId });
    // A new camera session must start with fresh ByteTrack IDs so people who
    // left during a previous session are not confused with new arrivals.
    // Await it so no frame is inferred against the previous track history.
    await resetBackendTracker();
    if (epoch !== state.sessionEpoch) return;
    postHeartbeat("connected");
    startInferenceLoop();
    startHeartbeatLoop();
  } catch (err) {
    if (epoch !== state.sessionEpoch) return;
    console.error("Camera access error:", err);
    const message = describeCameraError(err);
    setState({ stream: null, cameraStatus: cameraStatusForError(err), errorMessage: message });
    postHeartbeat(message);
  }
}

/**
 * Handles a camera that disappears mid-session (unplugged, closed by another
 * app, hardware fault). Without this the last count would freeze on screen
 * while the UI still claimed the camera was active.
 */
function watchStreamEnd(stream, epoch) {
  stream.getVideoTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (epoch !== state.sessionEpoch || state.stream !== stream) return;
      stopInferenceLoop();
      stopHeartbeatLoop();
      state.sessionEpoch += 1;
      state.stream = null;
      setState({
        stream: null,
        cameraStatus: CameraStatus.UNAVAILABLE,
        lastCount: null,
        lastDetections: [],
        lastDetectionAt: null,
        lastInferenceMs: null,
        errorMessage: "The camera stream ended. Reconnect the camera and press Restart Camera."
      });
      postHeartbeat("stream_ended");
    });
  });
}

function cameraStatusForError(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return CameraStatus.PERMISSION_DENIED;
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return CameraStatus.UNAVAILABLE;
  }
  return CameraStatus.ERROR;
}

async function resetBackendTracker() {
  try {
    await fetch(API_RESET_TRACKER, { method: "POST" });
  } catch (err) {
    console.warn("Could not reset backend tracker:", err);
  }
}

export function stopCamera() {
  stopInferenceLoop();
  stopHeartbeatLoop();
  // Invalidate any detection response that is still in flight.
  state.sessionEpoch += 1;
  stopTracks();
  setState({
    stream: null,
    cameraStatus: CameraStatus.IDLE,
    lastCount: null,
    lastDetections: [],
    lastDetectionAt: null,
    lastFrameSize: null,
    lastInferenceMs: null,
    errorMessage: ""
  });
  postHeartbeat("stopped");
}

export function restartCamera() {
  stopCamera();
  setTimeout(() => startCamera(state.selectedDeviceId), 250);
}

function stopTracks() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (e) {
        console.warn("Error stopping track:", e);
      }
    });
  }
  if (captureVideo) {
    captureVideo.srcObject = null;
  }
}

/**
 * Attaches the shared stream to a visible <video> element.
 * Returns true when a stream was attached.
 */
export function attachVideo(element) {
  if (!element) return false;
  if (state.stream) {
    if (element.srcObject !== state.stream) {
      element.srcObject = state.stream;
    }
    element.muted = true;
    const playPromise = element.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err) => console.warn("Video play error:", err));
    }
    return true;
  }
  element.srcObject = null;
  return false;
}

export function detachVideo(element) {
  if (element && element.srcObject) {
    element.srcObject = null;
  }
}

function describeCameraError(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "Camera permission denied. Allow camera access in the browser address bar and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera detected on this computer. Connect a webcam and try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Camera is currently in use by another application. Close other camera apps and try again.";
  }
  if (name === "OverconstrainedError") {
    return "Requested camera constraint or resolution is not supported by this hardware.";
  }
  return `Camera error: ${err?.message || name || "unknown error"}`;
}

export function statusLabel(status) {
  switch (status) {
    case CameraStatus.CONNECTED:
      return "Connected";
    case CameraStatus.CONNECTING:
      return "Connecting";
    case CameraStatus.PERMISSION_DENIED:
      return "Permission denied";
    case CameraStatus.UNAVAILABLE:
      return "Camera unavailable";
    case CameraStatus.ERROR:
      return "Camera unavailable";
    default:
      return "Camera off";
  }
}

/* ------------------------------------------------------------------ */
/* Inference loop (single owner)                                        */
/* ------------------------------------------------------------------ */

async function attachCaptureStream(stream) {
  if (!captureVideo) {
    captureVideo = document.createElement("video");
    captureVideo.playsInline = true;
    captureVideo.muted = true;
    captureVideo.autoplay = true;
  }
  captureVideo.srcObject = stream;
  await new Promise((resolve) => {
    const onReady = () => {
      captureVideo.removeEventListener("loadedmetadata", onReady);
      resolve();
    };
    captureVideo.addEventListener("loadedmetadata", onReady);
    captureVideo.play().catch(() => {});
    setTimeout(resolve, 1500);
  });
}

function startInferenceLoop() {
  stopInferenceLoop();
  const epoch = state.sessionEpoch;
  const tick = async () => {
    if (epoch !== state.sessionEpoch) return;
    if (!state.stream || state.cameraStatus !== CameraStatus.CONNECTED) return;
    await processVideoFrame(epoch);
    if (epoch !== state.sessionEpoch) return;
    inferenceTimer = setTimeout(tick, INFERENCE_INTERVAL_MS);
  };
  inferenceTimer = setTimeout(tick, 0);
}

function stopInferenceLoop() {
  if (inferenceTimer) {
    clearTimeout(inferenceTimer);
    inferenceTimer = null;
  }
  if (inferenceAbort) {
    inferenceAbort.abort();
    inferenceAbort = null;
  }
  state.processing = false;
}

/**
 * Captures the current frame and sends it to the backend for real YOLO
 * inference. The backend stores the resulting count for the active bus.
 *
 * Only one frame is ever in flight; the next capture starts when the previous
 * inference returns. That keeps the displayed number current without building
 * a request backlog on slow (CPU) inference.
 */
async function processVideoFrame(epoch) {
  if (epoch !== state.sessionEpoch) return;
  if (!captureVideo || captureVideo.readyState < 2 || state.processing) return;
  state.processing = true;
  const busId = state.busId;

  try {
    const rawW = captureVideo.videoWidth || 640;
    const rawH = captureVideo.videoHeight || 480;
    const scale = Math.min(1, MAX_CAPTURE_WIDTH / rawW);
    const captureW = Math.max(1, Math.round(rawW * scale));
    const captureH = Math.max(1, Math.round(rawH * scale));
    const offscreen = document.createElement("canvas");
    offscreen.width = captureW;
    offscreen.height = captureH;
    offscreen.getContext("2d").drawImage(captureVideo, 0, 0, captureW, captureH);
    const base64Jpeg = offscreen.toDataURL("image/jpeg", 0.8);

    inferenceAbort = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = inferenceAbort ? setTimeout(() => inferenceAbort.abort(), 15000) : null;

    const res = await fetch(API_DETECT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: base64Jpeg,
        bus_id: busId,
        // ByteTrack IDs let the backend de-duplicate the same person across
        // frames. The count still reflects the current frame only.
        track: true
      }),
      ...(inferenceAbort ? { signal: inferenceAbort.signal } : {})
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
      inferenceAbort = null;
    });

    // Ignore results that belong to a stopped/restarted camera or another bus.
    if (epoch !== state.sessionEpoch || busId !== state.busId) return;

    if (res.ok) {
      const data = await res.json();
      if (epoch !== state.sessionEpoch || busId !== state.busId) return;
      setState({
        modelStatus: ModelStatus.READY,
        lastCount: typeof data.count === "number" ? data.count : null,
        lastDetections: Array.isArray(data.detections) ? data.detections : [],
        lastDetectionAt: data.timestamp || new Date().toISOString(),
        lastFrameSize: {
          width: data.image_width || captureW,
          height: data.image_height || captureH
        },
        lastInferenceMs: typeof data.total_processing_ms === "number" ? data.total_processing_ms : null,
        // A successful inference clears any previous detection error.
        errorMessage: ""
      });
    } else {
      let detail = `HTTP ${res.status}`;
      try {
        const errData = await res.json();
        if (errData?.detail) detail = errData.detail;
      } catch (_) {
        /* keep status text */
      }
      if (epoch !== state.sessionEpoch) return;
      setState({
        modelStatus: ModelStatus.ERROR,
        errorMessage:
          res.status === 503
            ? `The backend YOLO model is unavailable (${detail}). Check the backend console and that yolov8n.pt is present.`
            : `Detection failed: ${detail}`
      });
    }
  } catch (err) {
    // An aborted request is expected when stopping/switching the camera.
    if (epoch === state.sessionEpoch && err?.name !== "AbortError") {
      console.error("Frame processing error:", err);
      const offline = err instanceof TypeError;
      setState({
        modelStatus: ModelStatus.ERROR,
        errorMessage: offline
          ? "Cannot reach the detection backend. Start the FastAPI backend on port 8001 and reload this page."
          : `Detection failed: ${err.message}`
      });
    }
  } finally {
    state.processing = false;
  }
}

/* ------------------------------------------------------------------ */
/* Backend heartbeat                                                   */
/* ------------------------------------------------------------------ */

function startHeartbeatLoop() {
  stopHeartbeatLoop();
  heartbeatTimer = setInterval(() => postHeartbeat("heartbeat"), HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeatLoop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Publishes the real camera state to the backend so every consumer (including
 * the Conductor Panel on another device) sees the same status.
 */
export async function postHeartbeat(reason = "") {
  const payload = {
    bus_id: state.busId,
    camera_status: state.cameraStatus,
    model_status: state.modelStatus,
    message: state.errorMessage || reason || "",
    session_id: state.sessionId
  };
  try {
    await fetch(API_SESSION, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn("Could not publish camera session heartbeat:", err);
  }
}

/**
 * Checks whether the backend has the YOLO model ready.
 */
export async function checkBackendModelStatus() {
  setState({ modelStatus: ModelStatus.LOADING });
  try {
    const res = await fetch("/api/health");
    if (!res.ok) {
      setState({
        modelStatus: ModelStatus.ERROR,
        errorMessage: `Backend health check failed (HTTP ${res.status}). Make sure the FastAPI backend on port 8001 is running.`
      });
      return false;
    }
    const data = await res.json();
    const ready = data.model_loaded === true || data.status === "healthy";
    if (ready) {
      setState({ modelStatus: ModelStatus.READY });
    } else {
      setState({
        modelStatus: ModelStatus.ERROR,
        errorMessage:
          "The backend is running but the YOLO model is not loaded. Check that ultralytics/torch are installed and yolov8n.pt exists, then restart the backend."
      });
    }
    return ready;
  } catch (err) {
    console.warn("Could not reach backend health check:", err);
    setState({
      modelStatus: ModelStatus.ERROR,
      errorMessage: "Cannot reach the detection backend. Start the FastAPI backend on port 8001 and reload this page."
    });
    return false;
  }
}
