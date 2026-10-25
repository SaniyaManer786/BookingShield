/**
 * SMART ST Control Center — Conductor Panel
 *
 * Three simple sections:
 *   A. Trip details   — real buses/routes/checkpoints from the backend database
 *   B. Passenger count — conductor inputs + the real shared camera estimate
 *   C. Result          — reported / expected / camera / difference + submit
 *
 * Data rules:
 *  - Buses, routes, checkpoint suggestions and previous checkpoints come from
 *    the FastAPI/SQLite backend. Nothing is invented in the browser.
 *  - The camera estimate is read from GET /api/conductor/camera-state, which is
 *    filled by POST /api/detect from the shared Computer Vision camera session.
 *    A missing/stale count is shown as unavailable — never as a number.
 *  - Checkpoint submissions are persisted with POST /api/conductor/checkpoint.
 *    Success is only shown after the backend confirms the database write.
 */

import { getActiveBusId, registerConsumer, setActiveBusId } from "./visionCamera.js";

const API = {
  buses: "/api/conductor/buses",
  routes: "/api/conductor/routes",
  checkpointOptions: "/api/conductor/checkpoint-options",
  latest: "/api/conductor/checkpoint/latest",
  history: "/api/conductor/checkpoints",
  byId: "/api/conductor/checkpoints",
  cameraState: "/api/conductor/camera-state",
  submit: "/api/conductor/checkpoint"
};

const CAMERA_POLL_MS = 2500;
const MAX_COUNT = 500;
const HISTORY_LIMIT = 5;

const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  buses: [],
  routes: [],
  checkpoints: [],
  busId: "",
  route: "",
  checkpointsLoading: false,
  camera: emptyCamera(),
  history: [],
  latest: null,
  selectedRecordId: null,
  submitting: false,
  pollTimer: null,
  pollBusy: false,
  loaded: false
};

let releaseConsumer = null;

/* ------------------------------------------------------------------ */
/* Data helpers                                                       */
/* ------------------------------------------------------------------ */

function emptyCamera() {
  return {
    loading: true,
    count: null,
    lastKnownCount: null,
    status: "unavailable",
    cameraStatus: "idle",
    modelStatus: "unknown",
    message: "",
    updatedAt: null,
    ageSeconds: null,
    stale: false,
    error: ""
  };
}

async function api(path, options = {}) {
  const res = await fetch(path, { cache: "no-store", ...options });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body && body.detail ? body.detail : `HTTP ${res.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

function currentBus() {
  return state.buses.find((bus) => bus.id === state.busId) || state.buses[0] || null;
}

function numberOf(id) {
  const raw = ($(id)?.value ?? "").trim();
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function text(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setValue(id, value) {
  const el = $(id);
  if (el) el.value = value === null || value === undefined ? "" : String(value);
}

const COUNT_FIELDS = [
  "condActiveTickets",
  "condValidPasses",
  "condOtherAuth",
  "condStartingOnboard",
  "condBoarded",
  "condAlighted"
];

/**
 * A new checkpoint starts with empty count fields. Nothing is copied from the
 * previous checkpoint, demo data or a hardcoded default; the conductor must
 * enter every count for this checkpoint manually.
 */
function resetCountFields() {
  COUNT_FIELDS.forEach((id) => setValue(id, ""));
  setValue("condNotes", "");
}

function plural(count) {
  return count === 1 ? "passenger" : "passengers";
}

function formatSigned(value) {
  if (value === null || value === undefined) return "—";
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return "0";
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/* ------------------------------------------------------------------ */
/* Calculations                                                       */
/* ------------------------------------------------------------------ */

/**
 * The single counting convention used across the UI, backend and database:
 *   reported_passengers = active_tickets + valid_passes + other_authorized
 *   expected_onboard    = starting_onboard + boarded - alighted
 *   difference          = reported_passengers - camera_estimate
 */
function readCounts() {
  return {
    activeTickets: numberOf("condActiveTickets"),
    validPasses: numberOf("condValidPasses"),
    otherAuthorized: numberOf("condOtherAuth"),
    startingOnboard: numberOf("condStartingOnboard"),
    boarded: numberOf("condBoarded"),
    alighted: numberOf("condAlighted")
  };
}

function cameraIsFresh() {
  return (
    !state.camera.loading &&
    !state.camera.error &&
    !state.camera.stale &&
    state.camera.status === "connected" &&
    typeof state.camera.count === "number"
  );
}

function cameraIsStale() {
  return (
    !state.camera.loading &&
    !state.camera.error &&
    (state.camera.stale || state.camera.status === "stale")
  );
}

function computeResult() {
  const counts = readCounts();
  const reported =
    counts.activeTickets + counts.validPasses + counts.otherAuthorized;
  const expected =
    counts.startingOnboard + counts.boarded - counts.alighted;
  const fresh = cameraIsFresh();
  const camera = fresh ? state.camera.count : null;
  const stale = cameraIsStale();
  const signed = camera === null ? null : reported - camera;
  const absolute = signed === null ? null : Math.abs(signed);

  let statusText;
  let tone;
  if (state.camera.loading) {
    statusText = "Loading camera count";
    tone = "pending";
  } else if (state.camera.error) {
    statusText = "Camera unavailable";
    tone = "offline";
  } else if (stale) {
    statusText = "Camera data stale";
    tone = "warning";
  } else if (!fresh) {
    statusText = "Camera unavailable";
    tone = "offline";
  } else if (signed === 0) {
    statusText = "Match";
    tone = "ok";
  } else {
    statusText = `Mismatch: ${absolute} ${plural(absolute)}`;
    tone = "mismatch";
  }

  return { ...counts, reported, expected, camera, stale, fresh, signed, absolute, statusText, tone };
}

/* ------------------------------------------------------------------ */
/* Rendering — camera                                                 */
/* ------------------------------------------------------------------ */

function cameraReason() {
  if (state.camera.loading) return "Loading the latest camera count…";
  if (state.camera.error) return `Backend camera state unavailable: ${state.camera.error}`;
  if (state.camera.status === "stale") {
    const lastSeen =
      typeof state.camera.lastKnownCount === "number"
        ? ` Last seen: ${state.camera.lastKnownCount} (${formatAge(state.camera.ageSeconds) || "age unknown"}).`
        : "";
    return `${state.camera.message || "The last camera frame is old."}${lastSeen} Open Computer Vision Monitoring to resume live counting.`;
  }
  if (state.camera.status === "unavailable") {
    return state.camera.message || "No camera frames received for this bus yet. Open Computer Vision Monitoring to start the camera.";
  }
  if (state.camera.status === "connecting") {
    return state.camera.message || "The camera is starting on the Computer Vision Monitoring page.";
  }
  if (state.camera.status === "permission_denied") {
    return state.camera.message || "Camera permission was denied on the Computer Vision Monitoring page.";
  }
  if (state.camera.status === "model_unavailable") {
    return state.camera.message || "The backend YOLO model is not loaded.";
  }
  if (state.camera.status === "error") {
    return state.camera.message || "The monitoring camera reported an error.";
  }
  return state.camera.message || "No live camera count is available.";
}

function renderCamera() {
  const camera = state.camera;
  const fresh = cameraIsFresh();
  const stale = cameraIsStale();
  // A stale/failed count is never displayed as the live camera estimate.
  const hasCount = fresh && typeof camera.count === "number";

  /* Section B read-only field */
  text("condCameraEstimate", hasCount ? String(camera.count) : "Unavailable");

  const badge = $("condCameraBadge");
  if (badge) {
    let cls = "cond-badge is-offline";
    let label = "Camera unavailable";
    if (camera.loading) {
      cls = "cond-badge is-pending";
      label = "Loading camera";
    } else if (fresh) {
      cls = "cond-badge is-ok";
      label = "Camera live";
    } else if (stale) {
      cls = "cond-badge is-warning";
      label = "Camera data stale";
    } else if (camera.error) {
      cls = "cond-badge is-error";
      label = "Camera unavailable";
    }
    badge.className = cls;
    badge.textContent = label;
  }

  let updatedText = "No camera frames yet";
  if (hasCount) {
    const age = formatAge(camera.ageSeconds);
    updatedText = age ? `Updated ${age}${camera.updatedAt ? ` · ${formatTime(camera.updatedAt)}` : ""}` : "Latest camera frame";
  } else if (stale && typeof camera.lastKnownCount === "number") {
    const age = formatAge(camera.ageSeconds);
    updatedText = `Last frame ${age || "age unknown"}${camera.updatedAt ? ` · ${formatTime(camera.updatedAt)}` : ""}`;
  } else if (camera.loading) {
    updatedText = "Loading…";
  } else if (camera.error) {
    updatedText = "Backend unreachable";
  }
  text("condCameraUpdated", updatedText);
  text("condCameraReason", cameraReason());
}

/* ------------------------------------------------------------------ */
/* Rendering — result                                                 */
/* ------------------------------------------------------------------ */

function renderResult() {
  const result = computeResult();

  text("condReportedValue", String(result.reported));
  text("condExpectedValue", String(result.expected));
  text("condCameraValue", result.camera === null ? "Unavailable" : String(result.camera));
  text("condDifferenceValue", formatSigned(result.signed));
  text(
    "condAbsoluteValue",
    result.absolute === null ? "Absolute difference: —" : `Absolute difference: ${result.absolute}`
  );
  text("condReportedFormula", `${result.activeTickets} + ${result.validPasses} + ${result.otherAuthorized} = ${result.reported}`);
  text("condExpectedFormula", `${result.startingOnboard} + ${result.boarded} − ${result.alighted} = ${result.expected}`);
  text(
    "condDifferenceFormula",
    result.signed === null
      ? "No live camera count to compare"
      : `${result.reported} − ${result.camera} = ${formatSigned(result.signed)} · absolute ${result.absolute}`
  );

  const difference = $("condDifferenceCard");
  if (difference) {
    difference.className = `cond-difference is-${result.tone}`;
  }

  const status = $("condResultStatus");
  if (status) {
    status.className = `cond-badge is-${
      result.tone === "ok" ? "ok" : result.tone === "mismatch" ? "error" : result.tone === "warning" ? "warning" : "offline"
    }`;
    status.textContent = result.statusText;
  }

  /* Inline validation warning for negative movement */
  const movementWarning = $("condMovementWarning");
  if (movementWarning) {
    movementWarning.style.display = result.expected < 0 ? "flex" : "none";
  }

  renderCamera();
  return result;
}

/* ------------------------------------------------------------------ */
/* Rendering — history                                                */
/* ------------------------------------------------------------------ */

function renderHistory() {
  const wrap = $("condHistoryBody");
  if (!wrap) return;
  if (!state.history.length) {
    wrap.innerHTML = `<tr><td colspan="7" class="cond-history-empty">No checkpoints saved for this bus yet.</td></tr>`;
    return;
  }
  wrap.innerHTML = state.history
    .map((row) => {
      const camera = row.camera_estimate === null || row.camera_estimate === undefined ? "—" : row.camera_estimate;
      const signed =
        row.difference === null || row.difference === undefined ? "—" : formatSigned(row.difference);
      const label = row.comparison_status_label
        ? row.comparison_status_label
        : row.camera_estimate === null || row.camera_estimate === undefined
          ? "Camera unavailable"
          : row.difference === 0
            ? "Match"
            : `Mismatch: ${Math.abs(row.difference)}`;
      const tone = label === "Match" ? "is-ok" : label.startsWith("Mismatch") ? "is-error" : "is-offline";
      const selected = state.selectedRecordId === row.id;
      return `<tr class="cond-history-row${selected ? " is-selected" : ""}" data-record-id="${esc(row.id)}" tabindex="0" role="button" aria-pressed="${selected ? "true" : "false"}" title="Load these saved counts into the form">
        <td>${esc(formatTime(row.created_at))}</td>
        <td class="cond-history-checkpoint">${esc(row.checkpoint)}</td>
        <td>${esc(row.reported_passengers)}</td>
        <td>${esc(row.expected_onboard)}</td>
        <td>${esc(camera)}</td>
        <td>${esc(signed)}</td>
        <td><span class="cond-badge ${tone}">${esc(label)}</span></td>
      </tr>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

function validateForm() {
  const errors = [];
  const counts = readCounts();

  if (!state.busId) errors.push("Select a bus registration number.");
  if (!($("condRoute")?.value || "").trim()) errors.push("Route is required.");
  if (!($("condCheckpoint")?.value || "").trim()) errors.push("Current checkpoint is required.");
  if (!($("condTripId")?.value || "").trim()) errors.push("Trip ID is required.");
  if (!($("condConductorId")?.value || "").trim()) errors.push("Conductor ID is required.");

  [
    ["Active tickets", "condActiveTickets", counts.activeTickets],
    ["Valid passes", "condValidPasses", counts.validPasses],
    ["Other authorized passengers", "condOtherAuth", counts.otherAuthorized],
    ["Starting onboard count", "condStartingOnboard", counts.startingOnboard],
    ["Passengers boarded", "condBoarded", counts.boarded],
    ["Passengers alighted", "condAlighted", counts.alighted]
  ].forEach(([label, id, value]) => {
    const el = $(id);
    const raw = (el?.value ?? "").trim();
    if (raw === "") {
      errors.push(`${label} is required.`);
    } else if (!/^\d+$/.test(raw)) {
      errors.push(`${label} must be a non-negative whole number.`);
    } else if (value > MAX_COUNT) {
      errors.push(`${label} cannot exceed ${MAX_COUNT}.`);
    }
  });

  if (counts.startingOnboard + counts.boarded - counts.alighted < 0) {
    errors.push("Passenger movement would produce a negative expected onboard count (starting + boarded − alighted < 0).");
  }

  return { errors, counts };
}

function showMessage(message, tone = "error") {
  const el = $("condFormMessage");
  if (!el) return;
  el.className = `cond-message is-${tone}`;
  el.textContent = message;
  el.style.display = message ? "flex" : "none";
}

function clearMessage() {
  const el = $("condFormMessage");
  if (el) {
    el.textContent = "";
    el.style.display = "none";
  }
}

/* ------------------------------------------------------------------ */
/* Backend loading                                                    */
/* ------------------------------------------------------------------ */

async function loadBootstrap() {
  clearMessage();
  try {
    const [busData, routeData] = await Promise.all([api(API.buses), api(API.routes)]);
    state.buses = Array.isArray(busData.buses) ? busData.buses : [];
    state.routes = Array.isArray(routeData.routes) ? routeData.routes : [];
    renderRouteOptions();

    if (!state.buses.length) {
      showMessage("No buses are registered in the backend database.", "error");
      return;
    }

    // Both pages must agree on one bus: the Monitoring page writes the latest
    // YOLO count for the shared active bus. Previously the panel always picked
    // state.buses[0] (the first row alphabetically) while the camera counted a
    // different bus, so the panel showed an old count from the wrong bus.
    const activeBusId = getActiveBusId();
    const initialBus = state.buses.find((bus) => bus.id === activeBusId) || state.buses[0];
    state.busId = initialBus.id;
    if (initialBus.id !== activeBusId) setActiveBusId(initialBus.id);

    renderBusOptions();
    applyBusDetails(initialBus, { keepCounts: false });
    state.loaded = true;

    state.route = $("condRoute")?.value || initialBus.route || "";
    await Promise.all([
      loadCheckpointOptions(initialBus.id, state.route),
      loadLatest(initialBus.id),
      loadHistory(initialBus.id),
      fetchCamera(initialBus.id)
    ]);
    renderResult();
    startCameraPolling();
  } catch (err) {
    state.loaded = false;
    showMessage(`Backend unavailable: ${err.message}`, "error");
    renderCamera();
  }
}

function renderBusOptions() {
  const select = $("condBus");
  if (!select) return;
  select.innerHTML = state.buses
    .map((bus) => `<option value="${esc(bus.id)}"${bus.id === state.busId ? " selected" : ""}>${esc(bus.id)}${bus.fleet ? ` · ${esc(bus.fleet)}` : ""}</option>`)
    .join("");
  select.value = state.busId;
}

function renderRouteOptions() {
  const select = $("condRoute");
  if (!select) return;
  const currentValue = select.value || state.route || "";
  select.innerHTML = state.routes
    .map((row) => `<option value="${esc(row.route)}">${esc(row.route)}</option>`)
    .join("");
  if (currentValue) {
    select.value = currentValue;
    state.route = currentValue;
  } else if (select.options.length > 0) {
    select.value = select.options[0].value;
    state.route = select.value;
  }
}

function renderCheckpointOptions() {
  const select = $("condCheckpoint");
  if (!select) return;
  const currentValue = select.value || "";
  select.innerHTML = state.checkpoints
    .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
    .join("");
  if (currentValue && state.checkpoints.includes(currentValue)) {
    select.value = currentValue;
  } else if (state.checkpoints.length > 0) {
    select.value = state.checkpoints[0];
  } else {
    select.value = "";
  }
}

function applyBusDetails(bus, { keepCounts = true } = {}) {
  if (!bus) return;
  const routeVal = bus.route || "";
  setValue("condRoute", routeVal);
  state.route = routeVal;
  setValue("condTripId", bus.default_trip || "");
  setValue("condConductorId", bus.operator || "");
  if (!keepCounts) {
    resetCountFields();
    setValue("condCheckpoint", "");
  }
  text("condBusMeta", `${bus.fleet || "Fleet"} · ${bus.depot || "Depot"} depot · ${bus.capacity || "—"} seats`);
}

async function loadCheckpointOptions(busId, route) {
  try {
    const routeParam = route || state.route || ($("condRoute")?.value || "");
    const query = new URLSearchParams();
    if (busId) query.append("bus_id", busId);
    if (routeParam) query.append("route", routeParam);
    const data = await api(`${API.checkpointOptions}?${query.toString()}`);
    if (state.busId !== busId) return;
    state.checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
  } catch {
    if (state.busId !== busId) return;
    state.checkpoints = [];
  }
  renderCheckpointOptions();
}

async function loadLatest(busId) {
  try {
    const data = await api(`${API.latest}?bus_id=${encodeURIComponent(busId)}`);
    if (state.busId !== busId) return;
    state.latest = data && data.checkpoint ? data.checkpoint : null;
  } catch {
    if (state.busId !== busId) return;
    state.latest = null;
  }

  // The latest saved record is shown only as a reference note. Its counts are
  // never copied into the form: a new checkpoint must be entered manually.
  if (state.latest) {
    text(
      "condLatestNote",
      `Last saved: ${state.latest.checkpoint} · ${formatTime(state.latest.created_at)}`
    );
  } else {
    text("condLatestNote", "No previous checkpoint saved for this bus.");
  }
  renderResult();
}

/**
 * Copies an explicitly selected saved checkpoint into the form so it can be
 * viewed or corrected. This is only called from a user action on the history
 * table, never during initial load or bus selection.
 */
function applyCheckpointRecord(record) {
  if (!record) return;

  const routeSelect = $("condRoute");
  if (routeSelect && record.route) {
    if (!Array.from(routeSelect.options).some((option) => option.value === record.route)) {
      routeSelect.add(new Option(record.route, record.route));
    }
    routeSelect.value = record.route;
    state.route = record.route;
  }

  const checkpointSelect = $("condCheckpoint");
  if (checkpointSelect && record.checkpoint) {
    if (!Array.from(checkpointSelect.options).some((option) => option.value === record.checkpoint)) {
      checkpointSelect.add(new Option(record.checkpoint, record.checkpoint));
    }
    checkpointSelect.value = record.checkpoint;
  }

  setValue("condTripId", record.trip_id || "");
  setValue("condConductorId", record.conductor_id || "");
  setValue("condActiveTickets", record.active_tickets ?? "");
  setValue("condValidPasses", record.valid_passes ?? "");
  setValue("condOtherAuth", record.other_authorized ?? "");
  setValue("condStartingOnboard", record.starting_onboard ?? "");
  setValue("condBoarded", record.boarded ?? "");
  setValue("condAlighted", record.alighted ?? "");
  setValue("condNotes", record.notes || "");

  state.selectedRecordId = record.id ?? null;
  renderHistory();
  renderResult();
  const previewBox = $("condPreviewBox");
  if (previewBox) previewBox.style.display = "none";
  showMessage(
    `Loaded saved checkpoint #${record.id} (${record.checkpoint}). Review or edit the counts, then submit to record a new checkpoint.`,
    "info"
  );
}

async function loadCheckpointRecord(recordId) {
  if (recordId === null || recordId === undefined || recordId === "") return;
  let record = state.history.find((row) => String(row.id) === String(recordId)) || null;
  if (!record) {
    try {
      const data = await api(`${API.byId}/${encodeURIComponent(recordId)}`);
      record = data && data.checkpoint ? data.checkpoint : null;
    } catch (err) {
      showMessage(`Could not load checkpoint #${recordId}: ${err.message}`, "error");
      return;
    }
  }
  if (!record) {
    showMessage(`Checkpoint #${recordId} was not found.`, "error");
    return;
  }
  applyCheckpointRecord(record);
}

async function loadHistory(busId) {
  try {
    const data = await api(
      `${API.history}?bus_id=${encodeURIComponent(busId)}&limit=${HISTORY_LIMIT}`
    );
    if (state.busId !== busId) return;
    state.history = Array.isArray(data.checkpoints) ? data.checkpoints : [];
  } catch {
    if (state.busId !== busId) return;
    state.history = [];
  }
  renderHistory();
}

/* ------------------------------------------------------------------ */
/* Camera polling                                                     */
/* ------------------------------------------------------------------ */

async function fetchCamera(busId) {
  try {
    const data = await api(`${API.cameraState}?bus_id=${encodeURIComponent(busId)}`);
    if (state.busId !== busId) return;
    const status = data.status || "unavailable";
    const rawCount = typeof data.count === "number" ? data.count : null;
    const stale = !!data.stale || status === "stale";
    // Only a fresh "connected" response is a live count. The raw value is kept
    // as lastKnownCount so the panel can explain how old it is without ever
    // presenting it as current camera data.
    const fresh = status === "connected" && !stale && rawCount !== null;
    state.camera = {
      loading: false,
      count: fresh ? rawCount : null,
      lastKnownCount: rawCount,
      status,
      cameraStatus: data.camera_status || "idle",
      modelStatus: data.model_status || "unknown",
      message: data.message || "",
      updatedAt: data.updated_at || null,
      ageSeconds: typeof data.age_seconds === "number" ? data.age_seconds : null,
      stale,
      error: ""
    };
  } catch (err) {
    if (state.busId !== busId) return;
    state.camera = {
      ...emptyCamera(),
      loading: false,
      status: "error",
      error: err.message || "unknown error"
    };
  }
  renderResult();
}

function startCameraPolling() {
  stopCameraPolling();
  const poll = async () => {
    if (state.pollBusy || !state.busId) return;
    state.pollBusy = true;
    try {
      await fetchCamera(state.busId);
    } finally {
      state.pollBusy = false;
    }
  };
  poll();
  state.pollTimer = setInterval(poll, CAMERA_POLL_MS);
}

function stopCameraPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

function preview() {
  const { errors } = validateForm();
  if (errors.length) {
    showMessage(errors[0], "error");
    return null;
  }
  const result = renderResult();
  const previewBox = $("condPreviewBox");
  if (previewBox) {
    previewBox.style.display = "flex";
    const label =
      result.signed === null
        ? `${result.statusText} — no comparison is stored for this checkpoint.`
        : `${result.statusText} · reported ${result.reported}, expected ${result.expected}, camera ${result.camera}, difference ${formatSigned(result.signed)}.`;
    text("condPreviewText", label);
    previewBox.className = `cond-preview is-${result.tone}`;
  }
  showMessage("Preview ready. Review the comparison, then submit the checkpoint.", "info");
  return result;
}

async function submit() {
  if (state.submitting) return;
  const { errors, counts } = validateForm();
  if (errors.length) {
    showMessage(errors[0], "error");
    return;
  }

  state.submitting = true;
  const button = $("condSubmitBtn");
  const originalLabel = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Checking camera…";
  }

  try {
    // Re-read the same backend endpoint the panel polls so the stored snapshot
    // is the latest valid YOLO count, not a value that is up to one poll old.
    await fetchCamera(state.busId);

    const result = computeResult();
    const fresh = cameraIsFresh();
    const payload = {
      bus_id: state.busId,
      route: ($("condRoute")?.value || "").trim(),
      trip_id: ($("condTripId")?.value || "").trim(),
      checkpoint: ($("condCheckpoint")?.value || "").trim(),
      conductor_id: ($("condConductorId")?.value || "").trim(),
      active_tickets: counts.activeTickets,
      valid_passes: counts.validPasses,
      other_authorized: counts.otherAuthorized,
      starting_onboard: counts.startingOnboard,
      boarded: counts.boarded,
      alighted: counts.alighted,
      notes: ($("condNotes")?.value || "").trim(),
      // Only a live, non-stale count is sent as the camera estimate. When the
      // camera is unavailable/stale we explicitly tell the backend not to attach
      // an old snapshot, so no fabricated comparison is stored.
      camera_estimate: fresh ? state.camera.count : null,
      camera_detection_time: fresh ? state.camera.updatedAt || "" : "",
      camera_available: fresh
    };

    if (button) button.textContent = "Saving…";
    showMessage("Saving checkpoint to the backend database…", "info");

    const saved = await api(API.submit, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    clearMessage();
    const alertNote = saved.alert
      ? ` Mismatch alert ${saved.alert.alert_code || `#${saved.alert.id}`} raised${saved.alert.dispatch ? " and a checker was dispatched" : ""}.`
      : "";
    showMessage(
      `Checkpoint #${saved.id} saved at ${formatTime(saved.created_at)}. ${saved.comparison_status_label || result.statusText}.${alertNote}`,
      "success"
    );
    if (typeof window.__smartstToast === "function") {
      window.__smartstToast(`Checkpoint #${saved.id} saved.`);
    }

    await Promise.all([loadLatest(state.busId), loadHistory(state.busId), fetchCamera(state.busId)]);
    const previewBox = $("condPreviewBox");
    if (previewBox) previewBox.style.display = "none";
  } catch (err) {
    showMessage(`Checkpoint was not saved: ${err.message}`, "error");
  } finally {
    state.submitting = false;
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || "Submit checkpoint";
    }
  }
}

async function changeBus(busId) {
  if (!busId || busId === state.busId) return;
  state.busId = busId;
  // Keep the camera and the panel on the same bus. Subsequent YOLO frames are
  // published to the backend for this bus, so the polled camera count follows
  // the conductor's selection instead of an unrelated bus.
  setActiveBusId(busId);
  state.camera = emptyCamera();
  state.history = [];
  state.selectedRecordId = null;
  renderHistory();
  renderResult();
  const bus = currentBus();
  applyBusDetails(bus, { keepCounts: false });
  state.route = $("condRoute")?.value || bus?.route || "";
  clearMessage();
  await Promise.all([loadCheckpointOptions(busId, state.route), loadLatest(busId), loadHistory(busId), fetchCamera(busId)]);
  startCameraPolling();
}

/* ------------------------------------------------------------------ */
/* Markup                                                             */
/* ------------------------------------------------------------------ */

export function renderConductorPanel() {
  return `
    <div class="cond-shell">
      <header class="cond-page-head">
        <div>
          <h1>SMART ST — Conductor Panel</h1>
          <p>Fill the trip and passenger counts, review the camera comparison, then submit the checkpoint.</p>
        </div>
        <span class="cond-active-pill"><i></i> Trip active</span>
      </header>

      <!-- A. Trip details -->
      <section class="cond-card" aria-labelledby="condTripHeading">
        <div class="cond-card-head">
          <div class="cond-card-title">
            <span class="cond-step">A</span>
            <div>
              <h2 id="condTripHeading">Trip details</h2>
              <p>Bus, route and checkpoint for this report.</p>
            </div>
          </div>
          <span class="cond-hint" id="condLatestNote">Loading previous checkpoint…</span>
        </div>

        <div class="cond-grid cond-grid-3">
          <div class="cond-field">
            <label for="condBus">Bus registration</label>
            <select id="condBus" class="cond-input"></select>
            <span class="cond-help" id="condBusMeta">Fleet information</span>
          </div>

          <div class="cond-field">
            <label for="condRoute">Route</label>
            <select id="condRoute" class="cond-input"></select>
            <span class="cond-help">Routes from the database.</span>
          </div>

          <div class="cond-field">
            <label for="condCheckpoint">Current checkpoint</label>
            <select id="condCheckpoint" class="cond-input"></select>
            <span class="cond-help">Checkpoints for the selected route.</span>
          </div>

          <div class="cond-field">
            <label for="condTripId">Trip ID</label>
            <input id="condTripId" class="cond-input" placeholder="e.g. TRIP-1042-01" autocomplete="off" />
          </div>

          <div class="cond-field">
            <label for="condConductorId">Conductor ID</label>
            <input id="condConductorId" class="cond-input" placeholder="Conductor name or ID" autocomplete="off" />
          </div>
        </div>
      </section>

      <!-- B. Passenger count -->
      <section class="cond-card" aria-labelledby="condCountHeading">
        <div class="cond-card-head">
          <div class="cond-card-title">
            <span class="cond-step">B</span>
            <div>
              <h2 id="condCountHeading">Passenger count</h2>
              <p>Enter the counts recorded at this checkpoint.</p>
            </div>
          </div>
          <span class="cond-hint">Whole numbers · 0–${MAX_COUNT}</span>
        </div>

        <div class="cond-grid cond-grid-3">
          <div class="cond-field">
            <label for="condActiveTickets">Active tickets</label>
            <input id="condActiveTickets" class="cond-input cond-number" type="number" min="0" max="${MAX_COUNT}" step="1" inputmode="numeric" />
          </div>
          <div class="cond-field">
            <label for="condValidPasses">Valid passes</label>
            <input id="condValidPasses" class="cond-input cond-number" type="number" min="0" max="${MAX_COUNT}" step="1" inputmode="numeric" />
          </div>
          <div class="cond-field">
            <label for="condOtherAuth">Other authorized passengers</label>
            <input id="condOtherAuth" class="cond-input cond-number" type="number" min="0" max="${MAX_COUNT}" step="1" inputmode="numeric" />
          </div>

          <div class="cond-field">
            <label for="condStartingOnboard">Starting onboard count</label>
            <input id="condStartingOnboard" class="cond-input cond-number" type="number" min="0" max="${MAX_COUNT}" step="1" inputmode="numeric" />
          </div>
          <div class="cond-field">
            <label for="condBoarded">Passengers boarded since last checkpoint</label>
            <input id="condBoarded" class="cond-input cond-number" type="number" min="0" max="${MAX_COUNT}" step="1" inputmode="numeric" />
          </div>
          <div class="cond-field">
            <label for="condAlighted">Passengers alighted since last checkpoint</label>
            <input id="condAlighted" class="cond-input cond-number" type="number" min="0" max="${MAX_COUNT}" step="1" inputmode="numeric" />
          </div>
        </div>

        <div class="cond-split">
          <div class="cond-camera-box">
            <div class="cond-camera-line">
              <span class="cond-camera-icon" aria-hidden="true">📷</span>
              <div>
                <span class="cond-label">Live camera passenger estimate</span>
                <strong id="condCameraEstimate" class="cond-camera-value">Unavailable</strong>
              </div>
              <span id="condCameraBadge" class="cond-badge is-offline">Camera unavailable</span>
            </div>
            <p class="cond-camera-updated" id="condCameraUpdated">No camera frames yet</p>
            <p class="cond-camera-reason" id="condCameraReason">Open Computer Vision Monitoring to start the camera.</p>
            <a class="cond-link" id="condCameraLink" href="#" data-goto="Computer Vision Monitoring">Open Computer Vision Monitoring ↗</a>
          </div>

          <div class="cond-field">
            <label for="condNotes">Notes <span class="cond-optional">(optional)</span></label>
            <textarea id="condNotes" class="cond-input cond-textarea" rows="4" maxlength="500" placeholder="Optional operational notes"></textarea>
            <span class="cond-help">Do not include personal passenger details.</span>
          </div>
        </div>
        <p class="cond-limitation">
          The camera estimate is the number of people visible in the latest processed frame; it is not a cumulative onboard counter.
        </p>
      </section>

      <!-- C. Result and submission -->
      <section class="cond-card" aria-labelledby="condResultHeading">
        <div class="cond-card-head">
          <div class="cond-card-title">
            <span class="cond-step">C</span>
            <div>
              <h2 id="condResultHeading">Result and submission</h2>
              <p>Reported passengers − camera estimate.</p>
            </div>
          </div>
          <span id="condResultStatus" class="cond-badge is-offline">Loading camera count</span>
        </div>

        <div class="cond-result-grid">
          <div class="cond-metric">
            <span>Conductor-reported passengers</span>
            <strong id="condReportedValue">0</strong>
            <small id="condReportedFormula">0 + 0 + 0 = 0</small>
          </div>
          <div class="cond-metric">
            <span>Expected onboard passengers</span>
            <strong id="condExpectedValue">0</strong>
            <small id="condExpectedFormula">0 + 0 − 0 = 0</small>
          </div>
          <div class="cond-metric">
            <span>Camera-detected passengers</span>
            <strong id="condCameraValue">Unavailable</strong>
            <small>Live YOLO count, never estimated</small>
          </div>
          <div class="cond-difference is-pending" id="condDifferenceCard">
            <span>Difference (reported − camera)</span>
            <strong id="condDifferenceValue">—</strong>
            <small id="condAbsoluteValue">Absolute difference: —</small>
          </div>
        </div>

        <div class="cond-formula-row">
          <span>Difference calculation</span>
          <code id="condDifferenceFormula">No live camera count to compare</code>
        </div>

        <div class="cond-message is-error" id="condFormMessage" style="display:none"></div>
        <div class="cond-message is-warning" id="condMovementWarning" style="display:none">
          Passenger movement would produce a negative expected onboard count. Check the starting, boarded and alighted values.
        </div>

        <div class="cond-preview" id="condPreviewBox" style="display:none">
          <strong>Preview</strong>
          <span id="condPreviewText"></span>
        </div>

        <div class="cond-actions">
          <button class="btn" type="button" id="condPreviewBtn">Preview comparison</button>
          <button class="btn btn-primary" type="button" id="condSubmitBtn">Submit checkpoint</button>
        </div>

        <div class="cond-history">
          <div class="cond-history-head">
            <h3>Recent checkpoints</h3>
            <span>Select a row to load its saved counts · Last ${HISTORY_LIMIT} saved records for this bus</span>
          </div>
          <div class="cond-table-wrap">
            <table class="cond-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Checkpoint</th>
                  <th>Reported</th>
                  <th>Expected</th>
                  <th>Camera</th>
                  <th>Diff.</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="condHistoryBody">
                <tr><td colspan="7" class="cond-history-empty">Loading saved checkpoints…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

export function wireConductorPanelControls() {
  // Hold the shared camera consumer registration so navigating here from the
  // Computer Vision page does not tear down the single camera session.
  releaseConsumer = registerConsumer("conductor-panel");

  state.busId = "";
  state.camera = emptyCamera();
  state.history = [];
  state.latest = null;
  state.selectedRecordId = null;
  renderResult();
  renderHistory();
  showMessage("", "info");

  $("condBus")?.addEventListener("change", (event) => changeBus(event.target.value));

  // Saved counts are loaded only when the conductor explicitly picks a history
  // row. Initial load and bus changes always start from an empty count form.
  const historyBody = $("condHistoryBody");
  historyBody?.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-record-id]");
    if (row) loadCheckpointRecord(row.dataset.recordId);
  });
  historyBody?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr[data-record-id]");
    if (!row) return;
    event.preventDefault();
    loadCheckpointRecord(row.dataset.recordId);
  });

  // Let the app-level [data-goto] handler navigate, but stop the "#" anchor from
  // scrolling the page before the panel re-renders.
  $("condCameraLink")?.addEventListener("click", (event) => event.preventDefault());

  ["condActiveTickets", "condValidPasses", "condOtherAuth", "condStartingOnboard", "condBoarded", "condAlighted"].forEach((id) => {
    $(id)?.addEventListener("input", () => {
      renderResult();
      const previewBox = $("condPreviewBox");
      if (previewBox && previewBox.style.display !== "none") previewBox.style.display = "none";
    });
  });

  $("condRoute")?.addEventListener("change", async (event) => {
    state.route = event.target.value || "";
    const previewBox = $("condPreviewBox");
    if (previewBox) previewBox.style.display = "none";
    await loadCheckpointOptions(state.busId, state.route);
  });

  $("condPreviewBtn")?.addEventListener("click", preview);
  $("condSubmitBtn")?.addEventListener("click", submit);

  if (window.__stopConductorPolling) window.__stopConductorPolling = cleanupConductorPanel;
  window.__stopConductorPolling = cleanupConductorPanel;

  loadBootstrap();
}

export function cleanupConductorPanel() {
  stopCameraPolling();
  if (releaseConsumer) {
    releaseConsumer();
    releaseConsumer = null;
  }
  if (window.__stopConductorPolling === cleanupConductorPanel) {
    window.__stopConductorPolling = null;
  }
}
