/**
 * SMART ST Control Center - Conductor Panel Module
 * Specification: SMART ST — Conductor Panel
 * Checkpoint-by-checkpoint passenger accounting with persistent SQLite backend and real-time YOLO Computer Vision cross-verification.
 */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Module state
let pollingTimer = null;
let currentBusId = "MH-12-QW-4821";
let currentRoute = "Pune – Mumbai";
let currentTripId = "TRIP-1042-01";
let currentCheckpoint = "Lonavala Bus Stand";
let currentConductorId = "A. Jadhav";

let registeredBuses = [];
let latestCameraData = { count: null, updatedAt: null, loading: false, error: null };
let checkpointHistory = [];
let isSubmitting = false;

// Standard Maharashtra State Transport route checkpoint presets
const CHECKPOINT_PRESETS = [
  "Swargate Bus Station",
  "Katraj Tunnel / Bypass",
  "Khandala Ghat Checkpoint",
  "Lonavala Bus Stand",
  "Khopoli Toll Plaza",
  "Panvel Bus Terminal",
  "Vashi Highway Stop",
  "Dadar TT Station",
  "Mumbai Central Depot",
  "Shivajinagar Depot",
  "Nashik Road Depot",
  "Kolhapur Central Stand"
];

/**
 * Cleanup polling timer when navigating away from Conductor Panel
 */
export function cleanupConductorPanel() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

/**
 * Formats ISO timestamp to Indian Standard Time time string
 */
function formatTime(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  } catch {
    return isoStr;
  }
}

/**
 * Formats ISO timestamp to date & time string
 */
function formatDateTime(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    const datePart = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    const timePart = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
    return `${datePart}, ${timePart}`;
  } catch {
    return isoStr;
  }
}

/**
 * Fetches registered buses from backend or falls back to demonstration fleet
 */
async function loadRegisteredBuses() {
  try {
    const res = await fetch("/api/conductor/buses");
    if (res.ok) {
      const data = await res.json();
      if (data.buses && data.buses.length > 0) {
        registeredBuses = data.buses;
        return;
      }
    }
  } catch (err) {
    console.warn("Could not fetch buses from backend, using default fleet:", err);
  }

  registeredBuses = [
    { id: "MH-12-QW-4821", fleet: "ST-1042", route: "Pune – Mumbai", depot: "Swargate", capacity: 52, operator: "A. Jadhav", default_trip: "TRIP-1042-01", status: "Active" },
    { id: "MH-14-BT-1906", fleet: "ST-0871", route: "Pune – Nashik", depot: "Shivajinagar", capacity: 52, operator: "S. Pawar", default_trip: "TRIP-0871-02", status: "Active" },
    { id: "MH-09-CV-3372", fleet: "ST-1208", route: "Pune – Kolhapur", depot: "Swargate", capacity: 52, operator: "R. Shinde", default_trip: "TRIP-1208-01", status: "Active" },
    { id: "MH-12-LM-6510", fleet: "ST-0644", route: "Pune – Satara", depot: "Katraj", capacity: 52, operator: "P. More", default_trip: "TRIP-0644-03", status: "Active" },
    { id: "MH-11-AX-2208", fleet: "ST-0955", route: "Pune – Solapur", depot: "Hadapsar", capacity: 52, operator: "N. Bhosale", default_trip: "TRIP-0955-01", status: "Active" },
    { id: "MH-01-CD-7834", fleet: "ST-1320", route: "Mumbai – Nashik", depot: "Mumbai Central", capacity: 52, operator: "M. Chavan", default_trip: "TRIP-1320-04", status: "Active" },
    { id: "MH-12-JK-9083", fleet: "ST-0712", route: "Pune – Mumbai", depot: "Swargate", capacity: 52, operator: "V. Koli", default_trip: "TRIP-0712-02", status: "Active" },
    { id: "MH-15-GH-4417", fleet: "ST-1106", route: "Pune – Nashik", depot: "Nashik Road", capacity: 52, operator: "D. Pawar", default_trip: "TRIP-1106-01", status: "Active" }
  ];
}

/**
 * Gets currently selected bus metadata
 */
function getSelectedBus() {
  return registeredBuses.find((b) => b.id === currentBusId) || {
    id: currentBusId,
    fleet: "ST-1042",
    route: currentRoute || "Pune – Mumbai",
    depot: "Swargate",
    operator: currentConductorId || "A. Jadhav",
    capacity: 52,
    default_trip: currentTripId || "TRIP-1042-01",
    status: "Active"
  };
}

/**
 * Fetches the latest camera detection count from the backend YOLO CV service
 */
async function fetchLatestCameraCount() {
  latestCameraData.loading = true;
  try {
    const res = await fetch(`/api/conductor/latest-detection?bus_id=${encodeURIComponent(currentBusId)}`);
    if (res.ok) {
      const data = await res.json();
      latestCameraData.count = data.detected_count;
      latestCameraData.updatedAt = data.updated_at;
      latestCameraData.error = null;
    } else {
      latestCameraData.error = `HTTP ${res.status}`;
      latestCameraData.count = null;
    }
  } catch (err) {
    latestCameraData.error = err.message;
    latestCameraData.count = null;
  } finally {
    latestCameraData.loading = false;
    updateCameraPreviewUi();
    updateLiveMetricsAndPreviews();
  }
}

/**
 * Fetches recent checkpoint submissions for the selected bus and trip
 */
async function fetchCheckpointHistory() {
  try {
    const res = await fetch(`/api/conductor/checkpoints?bus_id=${encodeURIComponent(currentBusId)}&trip_id=${encodeURIComponent(currentTripId)}&limit=20`);
    if (res.ok) {
      const data = await res.json();
      checkpointHistory = data.checkpoints || [];
      renderCheckpointHistoryTable();
      updateTripStatusBar();
    }
  } catch (err) {
    console.warn("Error fetching checkpoint history:", err);
  }
}

/**
 * Updates the trip status bar above the form based on recent submissions
 */
function updateTripStatusBar() {
  const statusEl = document.getElementById("condTripStatusText");
  const checkpointBadge = document.getElementById("condLastCheckpointBadge");
  if (!statusEl) return;

  if (checkpointHistory.length > 0) {
    const latest = checkpointHistory[0];
    statusEl.textContent = `Trip ${esc(currentTripId)} • Last recorded at ${esc(latest.checkpoint)} (${formatTime(latest.created_at)})`;
    if (checkpointBadge) {
      checkpointBadge.textContent = `${checkpointHistory.length} Checkpoint${checkpointHistory.length > 1 ? "s" : ""} Submitted`;
      checkpointBadge.className = "status status-normal";
    }
  } else {
    statusEl.textContent = `Trip ${esc(currentTripId)} • Ready for initial checkpoint submission`;
    if (checkpointBadge) {
      checkpointBadge.textContent = "New Trip Session";
      checkpointBadge.className = "status status-pending";
    }
  }
}

/**
 * Updates the dedicated Camera Count (Preview) Card
 */
function updateCameraPreviewUi() {
  const countEl = document.getElementById("condCameraCountValue");
  const timeEl = document.getElementById("condCameraUpdateTime");
  const statusEl = document.getElementById("condCameraStatusBadge");

  if (!countEl) return;

  if (latestCameraData.loading && latestCameraData.count === null) {
    countEl.innerHTML = `<span class="cond-loading-spinner">⏳</span> Fetching...`;
    if (statusEl) {
      statusEl.className = "status status-pending";
      statusEl.textContent = "Querying Camera...";
    }
    return;
  }

  if (latestCameraData.count !== null && latestCameraData.count !== undefined) {
    countEl.textContent = `${latestCameraData.count} passengers`;
    if (timeEl) {
      timeEl.textContent = `Updated: ${formatTime(latestCameraData.updatedAt)} (${latestCameraData.updatedAt ? new Date(latestCameraData.updatedAt).toLocaleTimeString("en-IN") : "recent"})`;
    }
    if (statusEl) {
      statusEl.className = "status status-normal";
      statusEl.textContent = "Live Camera Count";
    }
  } else {
    countEl.textContent = "Camera count unavailable";
    if (timeEl) {
      timeEl.textContent = "No camera detection frames received yet for this bus";
    }
    if (statusEl) {
      statusEl.className = "status status-pending";
      statusEl.textContent = "Camera count unavailable";
    }
  }
}

/**
 * Parses and strictly validates whole non-negative integers
 */
function parseStrictNonNegativeInt(val, fieldLabel, maxVal = 500) {
  const trimmed = String(val ?? "").trim();
  if (trimmed === "") {
    throw new Error(`${fieldLabel} is required. Please enter 0 or a positive whole number.`);
  }
  const n = Number(trimmed);
  if (isNaN(n) || !Number.isInteger(n)) {
    throw new Error(`${fieldLabel} must be a whole integer (decimals and non-numeric values are not allowed).`);
  }
  if (n < 0) {
    throw new Error(`${fieldLabel} cannot be negative.`);
  }
  if (n > maxVal) {
    throw new Error(`${fieldLabel} exceeds maximum allowable safety threshold (${maxVal}).`);
  }
  return n;
}

/**
 * Clears field-level error messages
 */
function clearFieldErrors() {
  const errorEls = document.querySelectorAll(".cond-field-error");
  errorEls.forEach((el) => {
    el.textContent = "";
    el.style.display = "none";
  });
  const inputs = document.querySelectorAll(".cond-form-flow .form-control");
  inputs.forEach((inp) => inp.classList.remove("input-error"));
}

/**
 * Sets a field-level error message
 */
function setFieldError(fieldId, errorMsg) {
  const input = document.getElementById(fieldId);
  const errorEl = document.getElementById(`err-${fieldId}`);
  if (input) input.classList.add("input-error");
  if (errorEl) {
    errorEl.textContent = errorMsg;
    errorEl.style.display = "block";
  }
}

/**
 * Computes live mathematical metrics for comparison preview
 */
function calculateMetrics() {
  const ticketsEl = document.getElementById("condActiveTickets");
  const passesEl = document.getElementById("condValidPasses");
  const otherEl = document.getElementById("condOtherAuth");
  const startEl = document.getElementById("condStartingOnboard");
  const boardedEl = document.getElementById("condBoarded");
  const alightedEl = document.getElementById("condAlighted");

  const rawTickets = ticketsEl ? ticketsEl.value.trim() : "";
  const rawPasses = passesEl ? passesEl.value.trim() : "";
  const rawOther = otherEl ? otherEl.value.trim() : "";
  const rawStart = startEl ? startEl.value.trim() : "";
  const rawBoarded = boardedEl ? boardedEl.value.trim() : "";
  const rawAlighted = alightedEl ? alightedEl.value.trim() : "";

  const tickets = rawTickets !== "" && !isNaN(Number(rawTickets)) && Number.isInteger(Number(rawTickets)) ? Math.max(0, parseInt(rawTickets, 10)) : 0;
  const passes = rawPasses !== "" && !isNaN(Number(rawPasses)) && Number.isInteger(Number(rawPasses)) ? Math.max(0, parseInt(rawPasses, 10)) : 0;
  const other = rawOther !== "" && !isNaN(Number(rawOther)) && Number.isInteger(Number(rawOther)) ? Math.max(0, parseInt(rawOther, 10)) : 0;
  const start = rawStart !== "" && !isNaN(Number(rawStart)) && Number.isInteger(Number(rawStart)) ? Math.max(0, parseInt(rawStart, 10)) : 0;
  const boarded = rawBoarded !== "" && !isNaN(Number(rawBoarded)) && Number.isInteger(Number(rawBoarded)) ? Math.max(0, parseInt(rawBoarded, 10)) : 0;
  const alighted = rawAlighted !== "" && !isNaN(Number(rawAlighted)) && Number.isInteger(Number(rawAlighted)) ? Math.max(0, parseInt(rawAlighted, 10)) : 0;

  const reportedPassengers = tickets + passes + other;
  const expectedOnboard = start + boarded - alighted;
  const cameraEstimate = latestCameraData.count;

  let difference = null;
  let status = "Comparison unavailable";
  let statusClass = "status status-pending";

  if (cameraEstimate !== null && expectedOnboard >= 0) {
    difference = cameraEstimate - expectedOnboard;
    if (difference === 0) {
      status = "Match";
      statusClass = "status status-normal";
    } else {
      status = "Discrepancy — verify";
      statusClass = "status status-mismatch";
    }
  }

  return {
    tickets,
    passes,
    other,
    start,
    boarded,
    alighted,
    rawTickets,
    rawPasses,
    rawStart,
    reportedPassengers,
    expectedOnboard,
    cameraEstimate,
    difference,
    status,
    statusClass
  };
}

/**
 * Updates live Illustrative Comparison Preview and Preview Checkpoint Submission sections
 */
function updateLiveMetricsAndPreviews() {
  const m = calculateMetrics();

  // 1. Illustrative Comparison Preview elements
  const reportedEl = document.getElementById("prevReportedPassengers");
  const expectedEl = document.getElementById("prevExpectedOnboard");
  const cameraEl = document.getElementById("prevCameraEstimate");
  const diffEl = document.getElementById("prevDifference");
  const statusEl = document.getElementById("prevComparisonStatus");
  const movementWarningEl = document.getElementById("prevMovementWarning");

  if (reportedEl) {
    reportedEl.textContent = `${m.reportedPassengers}`;
  }

  if (cameraEl) {
    cameraEl.textContent = m.cameraEstimate !== null ? `${m.cameraEstimate}` : "Camera count unavailable";
  }

  if (diffEl) {
    if (m.difference === null) {
      diffEl.textContent = "—";
      diffEl.style.color = "inherit";
    } else if (m.difference === 0) {
      diffEl.textContent = "0 passengers";
      diffEl.style.color = "#159a85";
    } else if (m.difference > 0) {
      diffEl.textContent = `+${m.difference} passengers`;
      diffEl.style.color = "#df5d59";
    } else {
      diffEl.textContent = `${m.difference} passengers`;
      diffEl.style.color = "#2864dc";
    }
  }

  if (statusEl) {
    statusEl.className = m.statusClass;
    statusEl.textContent = m.status;
  }

  if (movementWarningEl) {
    if (m.expectedOnboard < 0) {
      movementWarningEl.style.display = "block";
      movementWarningEl.textContent = `⚠ Movement error: alighted passengers (${m.alighted}) exceed current occupancy (${m.start + m.boarded}). Expected onboard cannot be negative (${m.expectedOnboard}).`;
    } else {
      movementWarningEl.style.display = "none";
    }
  }

  // 2. Preview Checkpoint Submission Elements
  const pBus = document.getElementById("submPreviewBus");
  const pRoute = document.getElementById("submPreviewRoute");
  const pTrip = document.getElementById("submPreviewTrip");
  const pCheckpoint = document.getElementById("submPreviewCheckpoint");
  const pTickets = document.getElementById("submPreviewTickets");
  const pPasses = document.getElementById("submPreviewPasses");
  const pOther = document.getElementById("submPreviewOther");
  const pStart = document.getElementById("submPreviewStart");
  const pBoarded = document.getElementById("submPreviewBoarded");
  const pAlighted = document.getElementById("submPreviewAlighted");
  const pReported = document.getElementById("submPreviewReported");
  const pExpected = document.getElementById("submPreviewExpected");
  const pCamera = document.getElementById("submPreviewCamera");
  const pDiff = document.getElementById("submPreviewDifference");
  const pNotes = document.getElementById("submPreviewNotes");

  const busSelect = document.getElementById("condBusSelect");
  const routeInput = document.getElementById("condRouteInput");
  const tripInput = document.getElementById("condTripIdInput");
  const checkpointInput = document.getElementById("condCheckpointInput");
  const notesInput = document.getElementById("condNotes");

  if (pBus) pBus.textContent = busSelect ? busSelect.value.trim().toUpperCase() : currentBusId;
  if (pRoute) pRoute.textContent = routeInput ? routeInput.value.trim() : currentRoute;
  if (pTrip) pTrip.textContent = tripInput ? tripInput.value.trim() : currentTripId;
  if (pCheckpoint) pCheckpoint.textContent = checkpointInput ? checkpointInput.value.trim() : currentCheckpoint;

  if (pTickets) pTickets.textContent = String(m.tickets);
  if (pPasses) pPasses.textContent = String(m.passes);
  if (pOther) pOther.textContent = String(m.other);
  if (pStart) pStart.textContent = String(m.start);
  if (pBoarded) pBoarded.textContent = String(m.boarded);
  if (pAlighted) pAlighted.textContent = String(m.alighted);
  if (pReported) pReported.textContent = String(m.reportedPassengers);
  if (pExpected) {
    pExpected.textContent = m.expectedOnboard >= 0 ? String(m.expectedOnboard) : `${m.expectedOnboard} (Negative - Invalid)`;
    pExpected.style.color = m.expectedOnboard < 0 ? "#df5d59" : "inherit";
  }
  if (pCamera) pCamera.textContent = m.cameraEstimate !== null ? `${m.cameraEstimate}` : "Unavailable";
  if (pDiff) {
    if (m.difference === null) {
      pDiff.textContent = "Unavailable";
    } else if (m.difference === 0) {
      pDiff.textContent = "0 passengers";
    } else if (m.difference > 0) {
      pDiff.textContent = `+${m.difference} passengers`;
    } else {
      pDiff.textContent = `${m.difference} passengers`;
    }
  }
  if (pNotes) {
    const notesVal = notesInput ? notesInput.value.trim() : "";
    pNotes.textContent = notesVal ? notesVal : "None";
  }

  // 3. Top KPI strip
  const reportedKpi = document.getElementById("kpiReportedDisplay");
  const expectedKpi = document.getElementById("kpiExpectedDisplay");
  const varianceKpi = document.getElementById("kpiVarianceDisplay");

  if (reportedKpi) reportedKpi.textContent = String(m.reportedPassengers);
  if (expectedKpi) expectedKpi.textContent = String(m.expectedOnboard >= 0 ? m.expectedOnboard : "Invalid");

  if (varianceKpi) {
    if (m.difference === null) {
      varianceKpi.textContent = "—";
      varianceKpi.className = "kpi-value";
      varianceKpi.style.color = "inherit";
    } else if (m.difference === 0) {
      varianceKpi.textContent = "0";
      varianceKpi.className = "kpi-value trend-up";
      varianceKpi.style.color = "#159a85";
    } else if (m.difference > 0) {
      varianceKpi.textContent = `+${m.difference}`;
      varianceKpi.className = "kpi-value number-bad";
      varianceKpi.style.color = "#df5d59";
    } else {
      varianceKpi.textContent = `${m.difference}`;
      varianceKpi.className = "kpi-value";
      varianceKpi.style.color = "#2864dc";
    }
  }
}

/**
 * Validates all inputs before submission
 */
function validateForm() {
  clearFieldErrors();
  let hasError = false;

  const busSelect = document.getElementById("condBusSelect");
  const routeInput = document.getElementById("condRouteInput");
  const tripInput = document.getElementById("condTripIdInput");
  const checkpointInput = document.getElementById("condCheckpointInput");
  const conductorInput = document.getElementById("condConductorInput");

  const ticketsInput = document.getElementById("condActiveTickets");
  const passesInput = document.getElementById("condValidPasses");
  const otherInput = document.getElementById("condOtherAuth");
  const startInput = document.getElementById("condStartingOnboard");
  const boardedInput = document.getElementById("condBoarded");
  const alightedInput = document.getElementById("condAlighted");
  const notesInput = document.getElementById("condNotes");

  const busId = busSelect ? busSelect.value.trim().toUpperCase() : "";
  const route = routeInput ? routeInput.value.trim() : "";
  const tripId = tripInput ? tripInput.value.trim().toUpperCase() : "";
  const checkpoint = checkpointInput ? checkpointInput.value.trim() : "";
  const conductorId = conductorInput ? conductorInput.value.trim() : "";
  const notes = notesInput ? notesInput.value.trim() : "";

  if (!busId) {
    setFieldError("condBusSelect", "Bus registration number is required.");
    hasError = true;
  }
  if (!route) {
    setFieldError("condRouteInput", "Route is required.");
    hasError = true;
  }
  if (!tripId) {
    setFieldError("condTripIdInput", "Trip identifier is required.");
    hasError = true;
  }
  if (!checkpoint) {
    setFieldError("condCheckpointInput", "Current checkpoint name is required.");
    hasError = true;
  }

  let activeTickets = 0;
  try {
    activeTickets = parseStrictNonNegativeInt(ticketsInput?.value, "Active tickets");
  } catch (err) {
    setFieldError("condActiveTickets", err.message);
    hasError = true;
  }

  let validPasses = 0;
  try {
    validPasses = parseStrictNonNegativeInt(passesInput?.value, "Valid passes");
  } catch (err) {
    setFieldError("condValidPasses", err.message);
    hasError = true;
  }

  let otherAuth = 0;
  if (otherInput && otherInput.value.trim() !== "") {
    try {
      otherAuth = parseStrictNonNegativeInt(otherInput.value, "Other authorized passengers");
    } catch (err) {
      setFieldError("condOtherAuth", err.message);
      hasError = true;
    }
  }

  let startingOnboard = 0;
  try {
    startingOnboard = parseStrictNonNegativeInt(startInput?.value, "Starting onboard count");
  } catch (err) {
    setFieldError("condStartingOnboard", err.message);
    hasError = true;
  }

  let boarded = 0;
  if (boardedInput && boardedInput.value.trim() !== "") {
    try {
      boarded = parseStrictNonNegativeInt(boardedInput.value, "Boarded passengers");
    } catch (err) {
      setFieldError("condBoarded", err.message);
      hasError = true;
    }
  }

  let alighted = 0;
  if (alightedInput && alightedInput.value.trim() !== "") {
    try {
      alighted = parseStrictNonNegativeInt(alightedInput.value, "Alighted passengers");
    } catch (err) {
      setFieldError("condAlighted", err.message);
      hasError = true;
    }
  }

  if (!hasError) {
    const expectedOnboard = startingOnboard + boarded - alighted;
    if (expectedOnboard < 0) {
      setFieldError(
        "condAlighted",
        `Invalid movement: starting (${startingOnboard}) + boarded (${boarded}) - alighted (${alighted}) produces negative onboard occupancy (${expectedOnboard}).`
      );
      hasError = true;
    }
  }

  if (hasError) {
    throw new Error("Please correct the highlighted validation errors before submitting.");
  }

  return {
    bus_id: busId,
    route,
    trip_id: tripId,
    checkpoint,
    conductor_id: conductorId,
    active_tickets: activeTickets,
    valid_passes: validPasses,
    other_authorized: otherAuth,
    starting_onboard: startingOnboard,
    boarded,
    alighted,
    notes,
    camera_estimate: latestCameraData.count,
    camera_detection_time: latestCameraData.updatedAt || ""
  };
}

/**
 * Submits the checkpoint record to the persistent backend
 */
async function handleCheckpointSubmit(e) {
  if (e) e.preventDefault();
  if (isSubmitting) return;

  const msgEl = document.getElementById("condSubmitFeedback");
  const submitBtn = document.getElementById("condSubmitBtn");

  try {
    // 1. Strict validation
    const payload = validateForm();

    // 2. Lock UI & prevent duplicate requests
    isSubmitting = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span>⏳</span> Saving Checkpoint Record...`;
    }
    if (msgEl) {
      msgEl.style.display = "block";
      msgEl.className = "cond-alert cond-alert-info";
      msgEl.innerHTML = "<span>ℹ</span> Transmitting checkpoint data to persistent database...";
    }

    // 3. Post to backend
    const res = await fetch("/api/conductor/checkpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      throw new Error(errData.detail || "Unable to save checkpoint record. Entered values have been preserved. Please retry.");
    }

    const saved = await res.json();

    // 4. Success message displaying saved record ID and server timestamp
    if (msgEl) {
      msgEl.className = "cond-alert cond-alert-success";
      msgEl.innerHTML = `
        <strong>✓ Checkpoint record saved successfully.</strong>
        <span>Record ID #${saved.id} confirmed at ${formatDateTime(saved.created_at)} for checkpoint <em>${esc(saved.checkpoint)}</em>. Expected onboard: <strong>${saved.expected_onboard} passengers</strong>.</span>
      `;
    }

    // 5. Update starting count for the next counting period to match current expected onboard
    const startInput = document.getElementById("condStartingOnboard");
    const boardedInput = document.getElementById("condBoarded");
    const alightedInput = document.getElementById("condAlighted");
    if (startInput) {
      startInput.value = String(saved.expected_onboard);
    }
    if (boardedInput) boardedInput.value = "0";
    if (alightedInput) alightedInput.value = "0";

    // 6. Refresh checkpoint history and camera state
    await fetchCheckpointHistory();
    await fetchLatestCameraCount();
  } catch (err) {
    if (msgEl) {
      msgEl.style.display = "block";
      msgEl.className = "cond-alert cond-alert-error";
      msgEl.innerHTML = `<strong>⚠ Submission Error:</strong> ${esc(err.message)}`;
    }
  } finally {
    isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `💾 Submit Checkpoint Record`;
    }
  }
}

/**
 * Renders the Recent Checkpoint Submissions Table
 */
function renderCheckpointHistoryTable() {
  const container = document.getElementById("condCheckpointHistoryContainer");
  if (!container) return;

  if (checkpointHistory.length === 0) {
    container.innerHTML = `
      <div class="cond-empty-history">
        <div class="empty-icon">📋</div>
        <strong>No checkpoint submissions recorded yet for this trip.</strong>
        <p>Complete the passenger accounting form above and click "Submit Checkpoint Record" to create the first checkpoint audit entry.</p>
      </div>
    `;
    return;
  }

  const rows = checkpointHistory.map((rec) => {
    let diffBadge = `<span class="mini-pill">Unavailable</span>`;
    if (rec.difference !== null && rec.difference !== undefined) {
      if (rec.difference === 0) {
        diffBadge = `<span class="status status-normal">Match (0)</span>`;
      } else if (rec.difference > 0) {
        diffBadge = `<span class="status status-mismatch">+${rec.difference} passengers</span>`;
      } else {
        diffBadge = `<span class="status status-reviewed">${rec.difference} passengers</span>`;
      }
    }

    return `
      <tr>
        <td>
          <strong>${esc(rec.checkpoint)}</strong>
          <small class="cond-table-sub">ID #${rec.id}</small>
        </td>
        <td>${formatDateTime(rec.created_at)}</td>
        <td><strong>${esc(rec.bus_id)}</strong></td>
        <td class="text-center">${rec.active_tickets}</td>
        <td class="text-center">${rec.valid_passes}</td>
        <td class="text-center">${rec.other_authorized || 0}</td>
        <td class="text-center"><strong style="color:#1f4cb8">${rec.expected_onboard}</strong></td>
        <td class="text-center">${rec.camera_estimate !== null && rec.camera_estimate !== undefined ? `<strong>${rec.camera_estimate}</strong>` : "—"}</td>
        <td class="text-center">${diffBadge}</td>
        <td><small class="cond-table-notes">${esc(rec.notes || "—")}</small></td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <div class="table-responsive">
      <table class="table cond-history-table">
        <thead>
          <tr>
            <th>Checkpoint Name</th>
            <th>Submission Date &amp; Time</th>
            <th>Bus Registration</th>
            <th class="text-center" title="Active Tickets">Tickets</th>
            <th class="text-center" title="Valid Passes">Passes</th>
            <th class="text-center" title="Other Authorized">Auth</th>
            <th class="text-center" title="Expected Onboard Occupancy">Exp. Onboard</th>
            <th class="text-center" title="Camera Detection Snapshot">Camera Estimate</th>
            <th class="text-center" title="Difference & Comparison Status">Difference &amp; Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Main HTML Template for SMART ST — Conductor Panel
 */
export function renderConductorPanel() {
  const bus = getSelectedBus();

  return `
    <div class="conductor-page-container">
      <!-- Page Heading: EXACT title and subtitle -->
      <div class="page-heading">
        <div>
          <h1>SMART ST — Conductor Panel</h1>
          <p>Record passenger counts at each checkpoint and compare conductor-reported information with the latest available camera estimate.</p>
        </div>
        <div class="heading-actions">
          <span id="condLastCheckpointBadge" class="status status-pending">Loading Trip...</span>
          <button class="btn" id="condManualRefreshBtn" title="Sync camera and checkpoint history">↻ Refresh Sync</button>
        </div>
      </div>

      <!-- Current Trip Status Bar -->
      <div class="cond-trip-status-banner">
        <div class="trip-status-info">
          <span class="trip-icon">🚍</span>
          <span id="condTripStatusText">Trip ${esc(currentTripId)} • Initializing route session...</span>
        </div>
        <div class="trip-status-route">
          <strong>Route:</strong> ${esc(bus.route)} &nbsp;|&nbsp; <strong>Depot:</strong> ${esc(bus.depot)} &nbsp;|&nbsp; <strong>Capacity:</strong> ${bus.capacity} seats
        </div>
      </div>

      <!-- Top Row: Card titled "Camera Count (Preview)" + Live KPI Summary -->
      <div class="cond-top-cards-grid">
        <!-- PART 4: Camera Count (Preview) Card -->
        <article class="panel cond-camera-preview-card">
          <div class="panel-heading">
            <div class="card-title-group">
              <span class="camera-lens-icon">📷</span>
              <div>
                <h2>Camera Count (Preview)</h2>
                <div class="panel-subtitle">Latest available people count from Computer Vision Monitoring backend</div>
              </div>
            </div>
            <span id="condCameraStatusBadge" class="status status-pending">Awaiting Camera Feed</span>
          </div>
          <div class="camera-preview-body">
            <div class="camera-count-display">
              <div class="camera-big-count" id="condCameraCountValue">
                <span class="cond-loading-spinner">⏳</span> Fetching...
              </div>
              <div class="camera-meta" id="condCameraUpdateTime">Querying backend detection service...</div>
            </div>
            <div class="camera-details-strip">
              <span class="mini-pill">YOLOv8 Person Detection (COCO 0)</span>
              <span class="mini-pill">Bus: ${esc(currentBusId)}</span>
              <button class="btn btn-primary" data-goto="Computer Vision Monitoring" style="font-size:10px; padding:4px 9px">
                Open Camera Stream ↗
              </button>
            </div>
          </div>
        </article>

        <!-- Live Metrics KPI Trio -->
        <div class="cond-kpi-subgrid">
          <article class="kpi-card">
            <div class="kpi-top">
              <span class="kpi-label">REPORTED PASSENGERS</span>
              <span class="kpi-icon teal">🎫</span>
            </div>
            <div class="kpi-value" id="kpiReportedDisplay">—</div>
            <div class="kpi-foot">Tickets + Passes + Authorized</div>
          </article>

          <article class="kpi-card">
            <div class="kpi-top">
              <span class="kpi-label">EXPECTED ONBOARD</span>
              <span class="kpi-icon">👥</span>
            </div>
            <div class="kpi-value" id="kpiExpectedDisplay">—</div>
            <div class="kpi-foot">Start + Boarded - Alighted</div>
          </article>

          <article class="kpi-card">
            <div class="kpi-top">
              <span class="kpi-label">COUNT VARIANCE</span>
              <span class="kpi-icon amber">⚖</span>
            </div>
            <div class="kpi-value" id="kpiVarianceDisplay">—</div>
            <div class="kpi-foot">Camera Estimate vs Expected Onboard</div>
          </article>
        </div>
      </div>

      <!-- Main Layout: Form (Left) & Illustrative Comparison Preview (Right) -->
      <div class="dashboard-grid cond-main-grid">
        <!-- Form Panel: Section A (Trip & Checkpoint Info) + PART 3 (Passenger Accounting) -->
        <section class="panel cond-form-panel">
          <form id="condCheckpointForm" class="cond-form-flow" novalidate>
            <!-- Section A: Trip and checkpoint information -->
            <div class="cond-section-box">
              <div class="cond-box-title">
                <span>📍</span> Trip and checkpoint information
              </div>
              <div class="form-grid">
                <!-- 1. Bus registration number -->
                <div class="form-group">
                  <label for="condBusSelect">Bus registration number <span class="required-star">*</span></label>
                  <select id="condBusSelect" class="form-control" aria-label="Bus registration number" required>
                    ${registeredBuses.map((b) => `<option value="${esc(b.id)}" ${b.id === currentBusId ? "selected" : ""}>${esc(b.id)} · ${esc(b.route)}</option>`).join("")}
                  </select>
                  <span class="cond-field-error" id="err-condBusSelect"></span>
                  <small class="field-hint">Select registered bus (e.g. MH-12-QW-4821).</small>
                </div>

                <!-- 2. Route -->
                <div class="form-group">
                  <label for="condRouteInput">Route <span class="required-star">*</span></label>
                  <input
                    id="condRouteInput"
                    class="form-control"
                    value="${esc(bus.route)}"
                    placeholder="Pune – Mumbai"
                    required
                  />
                  <span class="cond-field-error" id="err-condRouteInput"></span>
                  <small class="field-hint">Operating corridor route.</small>
                </div>

                <!-- 3. Current checkpoint -->
                <div class="form-group">
                  <label for="condCheckpointInput">Current checkpoint <span class="required-star">*</span></label>
                  <input
                    id="condCheckpointInput"
                    class="form-control"
                    list="checkpointPresetsList"
                    value="${esc(currentCheckpoint)}"
                    placeholder="Lonavala Bus Stand"
                    required
                  />
                  <datalist id="checkpointPresetsList">
                    ${CHECKPOINT_PRESETS.map((cp) => `<option value="${esc(cp)}"></option>`).join("")}
                  </datalist>
                  <span class="cond-field-error" id="err-condCheckpointInput"></span>
                  <small class="field-hint">Current bus checkpoint or stand.</small>
                </div>

                <!-- 4. Trip identifier -->
                <div class="form-group">
                  <label for="condTripIdInput">Trip identifier <span class="required-star">*</span></label>
                  <input
                    id="condTripIdInput"
                    class="form-control"
                    value="${esc(currentTripId)}"
                    placeholder="TRIP-1042-01"
                    required
                  />
                  <span class="cond-field-error" id="err-condTripIdInput"></span>
                  <small class="field-hint">Associated trip identifier.</small>
                </div>

                <!-- 5. Conductor identifier -->
                <div class="form-group full">
                  <label for="condConductorInput">Conductor identifier</label>
                  <input
                    id="condConductorInput"
                    class="form-control"
                    value="${esc(bus.operator)}"
                    placeholder="A. Jadhav (Emp ID: ST-409)"
                  />
                  <span class="cond-field-error" id="err-condConductorInput"></span>
                  <small class="field-hint">Assigned conductor identification (optional demonstration record).</small>
                </div>
              </div>
            </div>

            <!-- PART 3: Passenger Accounting -->
            <div class="cond-section-box">
              <div class="cond-box-title">
                <span>🎫</span> Passenger Accounting
              </div>
              
              <div class="form-grid">
                <!-- A. Active tickets -->
                <div class="form-group">
                  <label for="condActiveTickets">
                    Active tickets <span class="required-star">*</span>
                  </label>
                  <div class="input-with-icon">
                    <span class="input-icon">🎟</span>
                    <input
                      type="number"
                      id="condActiveTickets"
                      class="form-control"
                      min="0"
                      max="500"
                      step="1"
                      placeholder="e.g. 38"
                      required
                    />
                  </div>
                  <span class="cond-field-error" id="err-condActiveTickets"></span>
                  <small class="field-hint">Passengers represented by active tickets at current checkpoint.</small>
                </div>

                <!-- B. Valid passes -->
                <div class="form-group">
                  <label for="condValidPasses">
                    Valid passes <span class="required-star">*</span>
                  </label>
                  <div class="input-with-icon">
                    <span class="input-icon">💳</span>
                    <input
                      type="number"
                      id="condValidPasses"
                      class="form-control"
                      min="0"
                      max="500"
                      step="1"
                      placeholder="e.g. 5"
                      required
                    />
                  </div>
                  <span class="cond-field-error" id="err-condValidPasses"></span>
                  <small class="field-hint">Passengers represented by valid travel passes.</small>
                </div>

                <!-- C. Other authorized passengers -->
                <div class="form-group">
                  <label for="condOtherAuth">
                    Other authorized passengers
                  </label>
                  <div class="input-with-icon">
                    <span class="input-icon">🛡</span>
                    <input
                      type="number"
                      id="condOtherAuth"
                      class="form-control"
                      min="0"
                      max="500"
                      step="1"
                      placeholder="0"
                      value="0"
                    />
                  </div>
                  <span class="cond-field-error" id="err-condOtherAuth"></span>
                  <small class="field-hint">Other authorized passengers not in ticket or pass categories.</small>
                </div>

                <!-- D. Passengers already onboard at start -->
                <div class="form-group">
                  <label for="condStartingOnboard">
                    Passengers already onboard at start <span class="required-star">*</span>
                  </label>
                  <div class="input-with-icon">
                    <span class="input-icon">🛫</span>
                    <input
                      type="number"
                      id="condStartingOnboard"
                      class="form-control"
                      min="0"
                      max="500"
                      step="1"
                      placeholder="e.g. 40"
                      value="40"
                      required
                    />
                  </div>
                  <span class="cond-field-error" id="err-condStartingOnboard"></span>
                  <small class="field-hint">Passengers onboard when current counting period began.</small>
                </div>

                <!-- E. Passengers boarded during this counting period -->
                <div class="form-group">
                  <label for="condBoarded">
                    Passengers boarded during this period
                  </label>
                  <div class="input-with-icon">
                    <span class="input-icon">➕</span>
                    <input
                      type="number"
                      id="condBoarded"
                      class="form-control"
                      min="0"
                      max="500"
                      step="1"
                      placeholder="0"
                      value="0"
                    />
                  </div>
                  <span class="cond-field-error" id="err-condBoarded"></span>
                  <small class="field-hint">Passengers who boarded after starting count was recorded.</small>
                </div>

                <!-- F. Passengers alighted during this counting period -->
                <div class="form-group">
                  <label for="condAlighted">
                    Passengers alighted during this period
                  </label>
                  <div class="input-with-icon">
                    <span class="input-icon">➖</span>
                    <input
                      type="number"
                      id="condAlighted"
                      class="form-control"
                      min="0"
                      max="500"
                      step="1"
                      placeholder="0"
                      value="0"
                    />
                  </div>
                  <span class="cond-field-error" id="err-condAlighted"></span>
                  <small class="field-hint">Passengers who left the bus during the counting period.</small>
                </div>

                <!-- G. Optional notes -->
                <div class="form-group full">
                  <label for="condNotes">Optional notes</label>
                  <textarea
                    id="condNotes"
                    class="form-control cond-textarea"
                    rows="2"
                    placeholder="Short operational information (weather, ghat section delay, checkpoint conditions)..."
                    maxlength="500"
                  ></textarea>
                  <small class="field-hint">Do not collect passenger names, phone numbers, payment credentials, or personal information.</small>
                </div>
              </div>
            </div>

            <!-- Submit Feedback Alert Banner -->
            <div id="condSubmitFeedback" class="cond-alert" style="display:none"></div>

            <div class="cond-submit-bar">
              <button type="button" id="condClearBtn" class="btn">
                ↻ Reset Counts
              </button>
            </div>
          </form>
        </section>

        <!-- Right Side: PART 5 & PART 6 -->
        <div class="cond-right-stack">
          <!-- PART 5: Illustrative Comparison Preview -->
          <section class="panel cond-comparison-panel">
            <div class="panel-heading">
              <div>
                <h2>Illustrative Comparison Preview</h2>
                <div class="panel-subtitle">Calculated passenger counts vs real Computer Vision detection</div>
              </div>
              <span class="mini-pill">Real-Time Verification</span>
            </div>

            <!-- Comparison Metrics Card -->
            <div class="cond-comparison-card">
              <div class="comp-item-row">
                <div class="comp-item-meta">
                  <span class="comp-dot dot-reported"></span>
                  <div>
                    <strong>Reported passengers:</strong>
                    <small>activeTickets + validPasses + otherAuthorizedPassengers</small>
                  </div>
                </div>
                <div class="comp-item-value" id="prevReportedPassengers">—</div>
              </div>

              <div class="comp-item-row">
                <div class="comp-item-meta">
                  <span class="comp-dot dot-camera"></span>
                  <div>
                    <strong>Camera estimate:</strong>
                    <small>Latest actual people count from backend YOLO service</small>
                  </div>
                </div>
                <div class="comp-item-value" id="prevCameraEstimate">—</div>
              </div>

              <div class="comp-item-row comp-highlight-row">
                <div class="comp-item-meta">
                  <span class="comp-dot dot-diff"></span>
                  <div>
                    <strong>Difference:</strong>
                    <small>cameraEstimate - expectedOnboard</small>
                  </div>
                </div>
                <div class="comp-item-value" id="prevDifference">—</div>
              </div>

              <div class="comp-item-row comp-status-row">
                <div class="comp-item-meta">
                  <strong>Status:</strong>
                  <small>Match | Discrepancy — verify | Comparison unavailable</small>
                </div>
                <div class="comp-item-value">
                  <span id="prevComparisonStatus" class="status status-pending">Comparison unavailable</span>
                </div>
              </div>
            </div>

            <!-- Movement Validation Warning (if negative expected occupancy) -->
            <div id="prevMovementWarning" class="cond-alert cond-alert-error" style="display:none; margin-bottom:14px"></div>

            <!-- Operational Verification Guidance Box -->
            <div class="cond-notice-box">
              <div class="notice-head">
                <span class="notice-icon">ℹ</span>
                <strong>Operational Verification Guidance</strong>
              </div>
              <p>
                Camera counts can include crew members (driver and conductor) and can differ from conductor records due to timing, boarding, alighting, and visual occlusion.
              </p>
              <p class="notice-sub">
                <strong>Important:</strong> A discrepancy must never automatically be labelled fare evasion or passenger misconduct. If movement data is incomplete or negative, a reliable comparison is unavailable.
              </p>
            </div>
          </section>

          <!-- PART 6: Preview Checkpoint Submission -->
          <section class="panel cond-preview-submission-card">
            <div class="panel-heading">
              <div>
                <h2>Preview Checkpoint Submission</h2>
                <div class="panel-subtitle">Summary of pending submission — verify all values before saving</div>
              </div>
              <span class="status status-pending" id="condSubmissionStatusBadge">Pending Submission (Not Saved Yet)</span>
            </div>

            <div class="submission-preview-body">
              <div class="subm-preview-grid">
                <div class="subm-field">
                  <span>Bus registration number:</span>
                  <strong id="submPreviewBus">${esc(bus.id)}</strong>
                </div>
                <div class="subm-field">
                  <span>Route:</span>
                  <strong id="submPreviewRoute">${esc(bus.route)}</strong>
                </div>
                <div class="subm-field">
                  <span>Trip identifier:</span>
                  <strong id="submPreviewTrip">${esc(currentTripId)}</strong>
                </div>
                <div class="subm-field">
                  <span>Current checkpoint:</span>
                  <strong id="submPreviewCheckpoint">${esc(currentCheckpoint)}</strong>
                </div>
                <div class="subm-field">
                  <span>Active tickets:</span>
                  <strong id="submPreviewTickets">0</strong>
                </div>
                <div class="subm-field">
                  <span>Valid passes:</span>
                  <strong id="submPreviewPasses">0</strong>
                </div>
                <div class="subm-field">
                  <span>Other authorized passengers:</span>
                  <strong id="submPreviewOther">0</strong>
                </div>
                <div class="subm-field">
                  <span>Starting onboard count:</span>
                  <strong id="submPreviewStart">40</strong>
                </div>
                <div class="subm-field">
                  <span>Passengers boarded:</span>
                  <strong id="submPreviewBoarded">0</strong>
                </div>
                <div class="subm-field">
                  <span>Passengers alighted:</span>
                  <strong id="submPreviewAlighted">0</strong>
                </div>
                <div class="subm-field subm-highlight">
                  <span>Reported passenger total:</span>
                  <strong id="submPreviewReported">0</strong>
                </div>
                <div class="subm-field subm-highlight">
                  <span>Expected onboard count:</span>
                  <strong id="submPreviewExpected">40</strong>
                </div>
                <div class="subm-field">
                  <span>Latest camera estimate:</span>
                  <strong id="submPreviewCamera">—</strong>
                </div>
                <div class="subm-field">
                  <span>Calculated difference:</span>
                  <strong id="submPreviewDifference">—</strong>
                </div>
                <div class="subm-field subm-full">
                  <span>Optional notes:</span>
                  <strong id="submPreviewNotes">None</strong>
                </div>
              </div>

              <!-- Prominent Submit Checkpoint Record Button -->
              <div class="cond-submit-action-wrap">
                <button type="button" id="condSubmitBtn" class="btn btn-primary btn-large btn-submit-checkpoint">
                  💾 Submit Checkpoint Record
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>

      <!-- PART 9: Recent Checkpoint Submissions -->
      <section class="panel cond-history-panel">
        <div class="panel-heading">
          <div>
            <h2>Recent Checkpoint Submissions</h2>
            <div class="panel-subtitle">Durable audit trail of passenger checkpoints for ${esc(currentBusId)} (${esc(currentTripId)})</div>
          </div>
          <span class="mini-pill">SQLite Persistent Storage</span>
        </div>

        <div id="condCheckpointHistoryContainer">
          <div class="cond-loading-spinner" style="padding:20px; text-align:center">Loading checkpoint records...</div>
        </div>
      </section>
    </div>
  `;
}

/**
 * Wires DOM controls and attaches listeners
 */
export async function wireConductorPanelControls() {
  cleanupConductorPanel();

  await loadRegisteredBuses();

  // Synchronize global monitoring bus
  window.__activeMonitoringBusId = currentBusId;

  // Form submission via prominent button or form submit
  const form = document.getElementById("condCheckpointForm");
  if (form) {
    form.addEventListener("submit", handleCheckpointSubmit);
  }
  const submitBtn = document.getElementById("condSubmitBtn");
  if (submitBtn) {
    submitBtn.addEventListener("click", handleCheckpointSubmit);
  }

  // Clear / reset button
  document.getElementById("condClearBtn")?.addEventListener("click", () => {
    const t = document.getElementById("condActiveTickets");
    const p = document.getElementById("condValidPasses");
    const o = document.getElementById("condOtherAuth");
    const b = document.getElementById("condBoarded");
    const a = document.getElementById("condAlighted");
    const notes = document.getElementById("condNotes");
    if (t) t.value = "";
    if (p) p.value = "";
    if (o) o.value = "0";
    if (b) b.value = "0";
    if (a) a.value = "0";
    if (notes) notes.value = "";
    clearFieldErrors();
    updateLiveMetricsAndPreviews();
  });

  // Manual refresh button
  document.getElementById("condManualRefreshBtn")?.addEventListener("click", async () => {
    await fetchLatestCameraCount();
    await fetchCheckpointHistory();
    updateLiveMetricsAndPreviews();
  });

  // Numeric inputs live calculate listener
  const numericInputs = [
    "condActiveTickets",
    "condValidPasses",
    "condOtherAuth",
    "condStartingOnboard",
    "condBoarded",
    "condAlighted"
  ];
  numericInputs.forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      // Clear field error on typing
      const errEl = document.getElementById(`err-${id}`);
      if (errEl) {
        errEl.textContent = "";
        errEl.style.display = "none";
      }
      el.classList.remove("input-error");
      updateLiveMetricsAndPreviews();
    });
  });

  // Text inputs live update listener for preview
  const textInputs = ["condRouteInput", "condTripIdInput", "condCheckpointInput", "condNotes"];
  textInputs.forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      const errEl = document.getElementById(`err-${id}`);
      if (errEl) {
        errEl.textContent = "";
        errEl.style.display = "none";
      }
      el.classList.remove("input-error");
      updateLiveMetricsAndPreviews();
    });
  });

  // Bus selection dropdown
  const busSelect = document.getElementById("condBusSelect");
  busSelect?.addEventListener("change", async (e) => {
    currentBusId = e.target.value.trim().toUpperCase();
    window.__activeMonitoringBusId = currentBusId;

    const bus = getSelectedBus();
    currentRoute = bus.route;
    currentTripId = bus.default_trip || currentTripId;
    currentConductorId = bus.operator || currentConductorId;

    const routeInput = document.getElementById("condRouteInput");
    const tripInput = document.getElementById("condTripIdInput");
    const condInput = document.getElementById("condConductorInput");

    if (routeInput) routeInput.value = currentRoute;
    if (tripInput) tripInput.value = currentTripId;
    if (condInput) condInput.value = currentConductorId;

    await fetchLatestCameraCount();
    await fetchCheckpointHistory();
    updateLiveMetricsAndPreviews();
  });

  // Route, Trip, Checkpoint, Conductor change events
  document.getElementById("condRouteInput")?.addEventListener("change", (e) => {
    currentRoute = e.target.value.trim();
    updateLiveMetricsAndPreviews();
  });
  document.getElementById("condTripIdInput")?.addEventListener("change", async (e) => {
    currentTripId = e.target.value.trim().toUpperCase() || "TRIP-01";
    await fetchCheckpointHistory();
    updateLiveMetricsAndPreviews();
  });
  document.getElementById("condCheckpointInput")?.addEventListener("change", (e) => {
    currentCheckpoint = e.target.value.trim();
    updateLiveMetricsAndPreviews();
  });
  document.getElementById("condConductorInput")?.addEventListener("change", (e) => {
    currentConductorId = e.target.value.trim();
  });

  // Initial load
  await fetchLatestCameraCount();
  await fetchCheckpointHistory();
  updateLiveMetricsAndPreviews();

  // Polling every 3 seconds for YOLO camera updates with clean cleanup
  pollingTimer = setInterval(async () => {
    await fetchLatestCameraCount();
  }, 3000);

  // Hook into window cleanup for page transitions
  window.__stopConductorPolling = cleanupConductorPanel;
}
