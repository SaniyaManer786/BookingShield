const API = {
  buses: "/api/conductor/buses",
  fares: "/api/conductor/fares",
  categories: "/api/conductor/passenger-categories",
  routeStops: "/api/conductor/route-stops",
  tickets: "/api/conductor/tickets",
  passes: "/api/conductor/passes",
  ticketingSummary: "/api/conductor/ticketing/summary",
  activeTrip: "/api/conductor/trips/active",
  trips: "/api/conductor/trips"
};

const MAX_QUANTITY = 500;
const REFRESH_INTERVAL_MS = 10000;
const CATEGORY_ORDER = ["FULL", "HALF", "FREE", "CHILD"];
const CATEGORY_VISUALS = {
  FULL: { icon: "male", tone: "blue" },
  HALF: { icon: "female", tone: "pink" },
  FREE: { icon: "senior", tone: "green" },
  CHILD: { icon: "child", tone: "amber" }
};

const ICONS = {
  bus: '<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2s-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  pass: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h4"/><path d="M7 13h6"/><circle cx="17" cy="12" r="2"/>',
  rupee: '<path d="M6 3h12"/><path d="M6 8h12"/><path d="M6 13h3"/><path d="M9 13c6.7 0 6.7-10 0-10"/><path d="m6 13 8.5 8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M3 10h18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  print: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  male: '<circle cx="10" cy="14" r="5"/><path d="m14 10 6-6"/><path d="M14 4h6v6"/>',
  female: '<circle cx="12" cy="9" r="5"/><path d="M12 14v7"/><path d="M9 18h6"/>',
  senior: '<circle cx="12" cy="4" r="2"/><path d="M12 8v6"/><path d="m8 21 4-7 4 7"/><path d="m8 11 4-2 4 2"/>',
  child: '<circle cx="12" cy="8" r="5"/><path d="M9 8h.01"/><path d="M15 8h.01"/><path d="M9.5 11c.7.7 1.5 1 2.5 1s1.8-.3 2.5-1"/><path d="M7 21v-3a5 5 0 0 1 10 0v3"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  receipt: '<path d="M5 3v18l3-2 4 2 4-2 3 2V3l-3 2-4-2-4 2-3-2Z"/><path d="M9 9h6"/><path d="M9 13h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'
};

const state = {
  buses: [],
  busId: "",
  route: "",
  tripId: "",
  conductor: "",
  activeTrip: null,
  completedTrip: null,
  categories: [],
  fares: null,
  stops: [],
  summary: null,
  tickets: [],
  passes: [],
  loading: true,
  busy: false,
  mode: "ticket",
  selectedCategory: "FULL",
  quantity: 1,
  lastTicket: null,
  selectedTicketId: null,
  lastPass: null,
  showAllTransactions: false,
  message: "",
  messageTone: "info",
  requestId: "",
  loadToken: 0,
  refreshing: false,
  clockTimer: null,
  refreshTimer: null
};

let lastBusId = "";

const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));

function icon(name, className = "") {
  return `<svg class="cp-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.ticket}</svg>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = body && body.detail ? body.detail : `HTTP ${response.status}`;
    const error = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    error.status = response.status;
    throw error;
  }
  return body;
}

function resetState() {
  state.buses = [];
  state.busId = "";
  state.route = "";
  state.tripId = "";
  state.conductor = "";
  state.activeTrip = null;
  state.completedTrip = null;
  state.categories = [];
  state.fares = null;
  state.stops = [];
  state.summary = null;
  state.tickets = [];
  state.passes = [];
  state.loading = true;
  state.busy = false;
  state.mode = "ticket";
  state.selectedCategory = "FULL";
  state.quantity = 1;
  state.lastTicket = null;
  state.selectedTicketId = null;
  state.lastPass = null;
  state.showAllTransactions = false;
  state.message = "";
  state.messageTone = "info";
  state.requestId = "";
  state.refreshing = false;
  state.loadToken += 1;
}

function currentBus() {
  return state.buses.find((bus) => bus.id === state.busId) || null;
}

function currentCategory() {
  return state.categories.find((category) => category.code === state.selectedCategory) || null;
}

function hasActiveTrip() {
  return Boolean(state.activeTrip && state.activeTrip.status === "Active");
}

function tripStatus() {
  if (state.activeTrip) return state.activeTrip.status || "Active";
  if (state.completedTrip) return "Completed";
  return "Not started";
}

function routeEndpoints(route) {
  return String(route || "")
    .split(/\s+[-\u2013\u2014]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatMoney(value, currency = "INR") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Unavailable";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${currency || "INR"} ${amount.toFixed(2)}`;
  }
}

function formatDateTime(value) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatTime(value) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function formatClock() {
  const now = new Date();
  const day = now.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
  const time = now.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  return { day, time };
}

function updateClock() {
  const clock = $("cpClock");
  if (!clock) return;
  const now = formatClock();
  clock.innerHTML = `<span>${esc(now.day)}</span><strong>${esc(now.time)}</strong>`;
}

function initials(name) {
  const words = String(name || "ST").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "ST";
}

function fareForBasis(basis) {
  if (!state.fares) return null;
  if (basis === "full") return Number(state.fares.full_fare);
  if (basis === "half") return Number(state.fares.half_fare);
  if (basis === "free") return Number(state.fares.free_fare);
  return null;
}

function fareLabel(basis) {
  if (basis === "full") return "Full fare";
  if (basis === "half") return "Half fare";
  if (basis === "free") return "Free fare";
  return "Fare unavailable";
}

function categoryMeta(category) {
  return CATEGORY_VISUALS[category?.code] || { icon: "user", tone: "blue" };
}

function orderedCategories() {
  const byCode = new Map(state.categories.map((category) => [category.code, category]));
  return CATEGORY_ORDER.map((code) => byCode.get(code)).filter(Boolean);
}

function ticketCategories(ticket) {
  if (Array.isArray(ticket?.passenger_categories) && ticket.passenger_categories.length) {
    return ticket.passenger_categories
      .map((row) => row.category_label || row.category_code)
      .filter(Boolean)
      .join(" + ");
  }
  const labels = [];
  if (Number(ticket?.full_count) > 0) labels.push("Full fare");
  if (Number(ticket?.half_count) > 0) labels.push("Half fare");
  if (Number(ticket?.free_count) > 0) labels.push("Free fare");
  return labels.join(" + ") || "Passenger";
}

function readContext() {
  const bus = currentBus();
  const tripField = $("cpTripId");
  const conductorField = $("cpConductorId");
  return {
    busId: state.busId,
    route: state.route || bus?.route || "",
    tripId: (tripField?.value ?? state.tripId ?? "").trim(),
    conductorId: (conductorField?.value ?? state.conductor ?? "").trim()
  };
}

function makeRequestId() {
  if (!state.requestId) {
    state.requestId = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `ticket-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return state.requestId;
}

function clearRequestId() {
  if (!state.busy) state.requestId = "";
}

function setPageAlert(message) {
  const alert = $("cpPageAlert");
  if (!alert) return;
  alert.textContent = message || "";
  alert.hidden = !message;
}

function setMessage(message, tone = "info") {
  state.message = message || "";
  state.messageTone = tone;
  renderMessage();
}

function renderMessage() {
  const message = $("cpFormMessage");
  if (!message) return;
  message.className = `cp-message is-${state.messageTone}`;
  message.textContent = state.message;
  message.hidden = !state.message;
}

function showToast(message) {
  if (typeof window.__smartstToast === "function") {
    window.__smartstToast(message);
  }
}

function setLoading(value) {
  state.loading = value;
  const dashboard = $("cpDashboard");
  if (dashboard) dashboard.setAttribute("aria-busy", value ? "true" : "false");
}

function setBusy(value) {
  state.busy = value;
  updateActionState();
}

function updateActionState() {
  const active = hasActiveTrip();
  const issueButton = $("cpIssueBtn");
  const passButton = $("cpPassBtn");
  const clearButton = $("cpClearBtn");
  const startButton = $("cpStartTripBtn");
  const completeButton = $("cpCompleteTripBtn");
  const printButton = $("cpPrintBtn");

  if (issueButton) {
    issueButton.disabled = state.busy || state.loading || !active || !currentCategory();
    issueButton.innerHTML = `${icon("ticket")} ${state.busy ? "Processing…" : "Issue Ticket"}`;
  }
  if (passButton) {
    passButton.disabled = state.busy || state.loading || !active;
    passButton.innerHTML = `${icon("pass")} ${state.busy ? "Processing…" : "Register Pass"}`;
  }
  if (clearButton) clearButton.disabled = state.busy;
  if (startButton) {
    startButton.disabled = state.busy || state.loading || active;
    startButton.hidden = active;
  }
  if (completeButton) {
    completeButton.disabled = state.busy || state.loading || !active;
    completeButton.hidden = !active;
  }
  if (printButton) printButton.disabled = !state.lastTicket;
}

function renderHeader() {
  const context = readContext();
  const active = hasActiveTrip();
  const badge = $("cpHeaderStatus");
  const badgeText = $("cpHeaderStatusText");
  const name = $("cpConductorChipName");
  const id = $("cpConductorChipId");
  const avatar = $("cpConductorAvatar");
  const conductorName = state.activeTrip?.conductor_id || context.conductorId || currentBus()?.operator || "Unassigned";
  const conductorId = state.activeTrip?.conductor_id || context.conductorId || "Conductor ID unavailable";

  if (badge) badge.className = `cp-header-status ${active ? "is-active" : "is-idle"}`;
  if (badgeText) badgeText.textContent = active ? "Active trip" : "No active trip";
  if (name) name.textContent = conductorName || "Unassigned";
  if (id) id.textContent = conductorId;
  if (avatar) avatar.textContent = initials(conductorName);
}

function renderBusOptions() {
  const select = $("cpBusSelect");
  if (!select) return;
  select.innerHTML = state.buses
    .map((bus) => `<option value="${esc(bus.id)}"${bus.id === state.busId ? " selected" : ""}>${esc(bus.id)}${bus.fleet ? ` · ${esc(bus.fleet)}` : ""}</option>`)
    .join("");
  select.value = state.busId;
}

function renderTripCard() {
  const bus = currentBus();
  const parts = routeEndpoints(state.route);
  const status = tripStatus();
  const active = hasActiveTrip();
  const context = readContext();
  const busNumber = bus?.fleet || bus?.id || "Not assigned";
  const registration = bus?.fleet ? bus.id : "Registration unavailable";
  const source = parts[0] || "Source unavailable";
  const destination = parts.length > 1 ? parts[parts.length - 1] : "Destination unavailable";

  if ($("cpBusNumber")) $("cpBusNumber").textContent = busNumber;
  if ($("cpBusReg")) $("cpBusReg").textContent = registration;
  if ($("cpRouteName")) $("cpRouteName").textContent = state.route || "Not assigned";
  if ($("cpRouteNumber")) $("cpRouteNumber").textContent = "Route number unavailable";
  if ($("cpRouteEnds")) $("cpRouteEnds").textContent = `${source} → ${destination}`;

  const tripInput = $("cpTripId");
  if (tripInput && document.activeElement !== tripInput) {
    tripInput.value = context.tripId || state.tripId || "";
  }
  if (tripInput) tripInput.readOnly = active;

  const conductorInput = $("cpConductorId");
  if (conductorInput && document.activeElement !== conductorInput) {
    conductorInput.value = context.conductorId || "";
  }

  if ($("cpTripStart")) {
    $("cpTripStart").textContent = state.activeTrip?.started_at
      ? `Started ${formatDateTime(state.activeTrip.started_at)}`
      : "Trip has not started";
  }
  if ($("cpConductorMeta")) {
    $("cpConductorMeta").textContent = state.activeTrip?.conductor_id
      ? `ID ${state.activeTrip.conductor_id}`
      : "Conductor ID unavailable";
  }

  const badge = $("cpTripStatusBadge");
  if (badge) {
    badge.className = `cp-status-badge is-${status.toLowerCase().replace(/\s+/g, "-")}`;
    badge.textContent = status;
  }
  if ($("cpTripStatusMeta")) {
    $("cpTripStatusMeta").textContent = active
      ? "Trip is accepting ticket and pass transactions."
      : state.completedTrip
        ? `Completed ${formatDateTime(state.completedTrip.ended_at)}`
        : "Start the trip before issuing tickets.";
  }

  renderBusOptions();
  renderHeader();
  updateActionState();
}

function summaryValue(value, formatter = (item) => String(item)) {
  if (state.loading) return "Loading";
  if (!hasActiveTrip() || !state.summary) return "Unavailable";
  return formatter(value);
}

function renderSummaryCards() {
  const summary = state.summary;
  const value = (key) => summary ? summary[key] : null;
  if ($("cpStatExpected")) $("cpStatExpected").textContent = summaryValue(value("expected_passengers"), (item) => String(Number(item) || 0));
  if ($("cpStatTickets")) $("cpStatTickets").textContent = summaryValue(value("ticket_count"), (item) => String(Number(item) || 0));
  if ($("cpStatPassengers")) $("cpStatPassengers").textContent = summaryValue(value("pass_passengers"), (item) => String(Number(item) || 0));
  if ($("cpStatFare")) {
    $("cpStatFare").textContent = summaryValue(
      value("ticket_revenue"),
      (item) => formatMoney(item, state.fares?.currency || "INR")
    );
  }
}

function renderCategories() {
  const container = $("cpCategories");
  if (!container) return;
  if (state.loading) {
    container.innerHTML = `<div class="cp-category-skeleton"></div><div class="cp-category-skeleton"></div><div class="cp-category-skeleton"></div><div class="cp-category-skeleton"></div>`;
    return;
  }
  const categories = orderedCategories();
  if (!categories.length) {
    container.innerHTML = `<div class="cp-empty is-compact">${icon("info")}<span>Passenger categories are unavailable.</span></div>`;
    return;
  }
  if (!categories.some((category) => category.code === state.selectedCategory)) {
    state.selectedCategory = categories[0].code;
  }
  container.innerHTML = categories
    .map((category) => {
      const visual = categoryMeta(category);
      const selected = category.code === state.selectedCategory;
      const fare = fareForBasis(category.fare_basis);
      const fareText = fare === null ? "Unavailable" : formatMoney(fare, state.fares?.currency || "INR");
      return `
        <button class="cp-category is-${visual.tone}${selected ? " is-selected" : ""}" type="button" data-category="${esc(category.code)}" role="radio" aria-checked="${selected ? "true" : "false"}">
          <span class="cp-category-icon">${icon(visual.icon)}</span>
          <span class="cp-category-copy">
            <strong>${esc(category.label)}</strong>
            <small>${esc(fareLabel(category.fare_basis))}</small>
          </span>
          <span class="cp-category-fare">${esc(fareText)}</span>
          <span class="cp-category-check">${icon("check")}</span>
        </button>
      `;
    })
    .join("");
}

function setSelectOptions(select, values, preferred) {
  if (!select) return "";
  const current = preferred ?? select.value ?? "";
  select.innerHTML = values
    .map((value) => `<option value="${esc(value)}">${esc(value)}</option>`)
    .join("");
  if (values.includes(current)) {
    select.value = current;
  } else if (values.length) {
    select.value = values[0];
  } else {
    select.innerHTML = `<option value="">Stop unavailable</option>`;
    select.value = "";
  }
  return select.value;
}

function renderStops() {
  const boarding = $("cpBoarding");
  const destination = $("cpDestination");
  const passBoarding = $("cpPassBoarding");
  const passDestination = $("cpPassDestination");
  const currentBoarding = boarding?.value || "";
  const currentDestination = destination?.value || "";
  const currentPassBoarding = passBoarding?.value || "";
  const currentPassDestination = passDestination?.value || "";

  const preferredBoarding = state.stops.includes(currentBoarding)
    ? currentBoarding
    : state.stops[0] || "";
  const preferredDestination = state.stops.includes(currentDestination)
    ? currentDestination
    : state.stops.length > 1
      ? state.stops[state.stops.length - 1]
      : "";
  const preferredPassBoarding = state.stops.includes(currentPassBoarding)
    ? currentPassBoarding
    : state.stops[0] || "";
  const preferredPassDestination = state.stops.includes(currentPassDestination)
    ? currentPassDestination
    : state.stops.length > 1
      ? state.stops[state.stops.length - 1]
      : "";

  setSelectOptions(boarding, state.stops, preferredBoarding);
  setSelectOptions(destination, state.stops, preferredDestination);
  setSelectOptions(passBoarding, state.stops, preferredPassBoarding);
  setSelectOptions(passDestination, state.stops, preferredPassDestination);
  renderStopValidation();
  updateFarePreview();
}

function renderStopValidation() {
  const validation = $("cpStopValidation");
  if (!validation) return;
  const boarding = ($("cpBoarding")?.value || "").trim();
  const destination = ($("cpDestination")?.value || "").trim();
  let message = "";
  if (state.stops.length < 2) {
    message = "At least two route stops are required to issue a ticket.";
  } else if (!boarding || !destination) {
    message = "Select both a boarding stop and a destination stop.";
  } else if (boarding === destination) {
    message = "Destination stop must be different from the boarding stop.";
  }
  validation.textContent = message;
  validation.hidden = !message;
}

function renderFareSummary() {
  const category = currentCategory();
  const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.trunc(Number(state.quantity) || 1)));
  const unitFare = category ? fareForBasis(category.fare_basis) : null;
  const currency = state.fares?.currency || "INR";
  const total = unitFare === null ? null : unitFare * quantity;

  if ($("cpFarePer")) $("cpFarePer").textContent = unitFare === null ? "Unavailable" : formatMoney(unitFare, currency);
  if ($("cpTotalFare")) $("cpTotalFare").textContent = total === null ? "Unavailable" : formatMoney(total, currency);
  if ($("cpFareBreakdown")) {
    $("cpFareBreakdown").textContent = category
      ? `${category.label} × ${quantity} ${quantity === 1 ? "passenger" : "passengers"}`
      : "Select a passenger category.";
  }
  if ($("cpFareSource")) {
    $("cpFareSource").textContent = state.fares
      ? state.fares.configured
        ? "Using the configured route fare."
        : "Using the default route fare; it has not been configured yet."
      : "Route fare settings are unavailable.";
  }
}

function updateFarePreview() {
  const quantityInput = $("cpQty");
  const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.trunc(Number(state.quantity) || 1)));
  state.quantity = quantity;
  if (quantityInput && document.activeElement !== quantityInput) quantityInput.value = String(quantity);
  renderFareSummary();
  renderStopValidation();
  updateActionState();
}

function renderTransactions() {
  const body = $("cpTxBody");
  const count = $("cpTxCount");
  const viewAllButton = $("cpTxViewAll");
  if (!body) return;

  if (state.loading) {
    body.innerHTML = `<tr><td colspan="7"><div class="cp-table-loading"><span></span><span></span><span></span></div></td></tr>`;
    if (count) count.textContent = "Loading transactions";
    if (viewAllButton) viewAllButton.hidden = true;
    return;
  }

  if (!hasActiveTrip()) {
    body.innerHTML = `<tr><td colspan="7"><div class="cp-empty is-compact">${icon("receipt")}<span>Start a trip to see ticket and pass transactions.</span></div></td></tr>`;
    if (count) count.textContent = "No active trip";
    if (viewAllButton) viewAllButton.hidden = true;
    return;
  }

  const rows = [
    ...state.tickets.map((ticket) => ({
      type: "ticket",
      id: ticket.ticket_number,
      recordId: ticket.id,
      category: ticketCategories(ticket),
      passengers: Number(ticket.total_passengers) || 0,
      fare: Number(ticket.total_fare) || 0,
      currency: ticket.currency || state.fares?.currency || "INR",
      time: ticket.issued_at || ticket.created_at || ""
    })),
    ...state.passes.map((passengerPass) => ({
      type: "pass",
      id: passengerPass.pass_number || passengerPass.acknowledgement_id || `#${passengerPass.id}`,
      recordId: passengerPass.id,
      category: passengerPass.pass_type || "Pass",
      passengers: Number(passengerPass.passenger_count) || 0,
      fare: 0,
      currency: state.fares?.currency || "INR",
      time: passengerPass.created_at || ""
    }))
  ].sort((first, second) => String(second.time).localeCompare(String(first.time)));

  if (count) {
    count.textContent = `${rows.length} ${rows.length === 1 ? "transaction" : "transactions"}`;
  }
  if (viewAllButton) {
    viewAllButton.hidden = rows.length <= 5;
    viewAllButton.textContent = state.showAllTransactions ? "Show latest" : "View all";
  }

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="cp-empty is-compact">${icon("receipt")}<span>No ticket or pass transactions for this trip yet.</span></div></td></tr>`;
    return;
  }

  body.innerHTML = rows
    .slice(0, state.showAllTransactions ? rows.length : 5)
    .map((row, index) => `
      <tr${row.type === "ticket" ? ` class="is-clickable" tabindex="0" data-ticket-id="${esc(row.recordId)}" title="Open ticket preview"` : ""}>
        <td class="cp-table-index">${index + 1}</td>
        <td><span class="cp-type is-${row.type}">${row.type === "ticket" ? "Ticket" : "Pass"}</span></td>
        <td><strong class="cp-mono">${esc(row.id)}</strong></td>
        <td>${esc(row.category)}</td>
        <td>${row.passengers}</td>
        <td>${formatMoney(row.fare, row.currency)}</td>
        <td class="cp-table-time">${formatTime(row.time)}</td>
      </tr>
    `)
    .join("");
}

function renderPassengerSummary() {
  const summary = state.summary;
  const active = hasActiveTrip();
  const formatter = (value) => active && summary ? String(Number(value) || 0) : "—";
  if ($("cpSumFull")) $("cpSumFull").textContent = formatter(summary?.full_fare_passengers);
  if ($("cpSumHalf")) $("cpSumHalf").textContent = formatter(summary?.half_fare_passengers);
  if ($("cpSumFree")) $("cpSumFree").textContent = formatter(summary?.free_fare_passengers);
  if ($("cpSumPass")) $("cpSumPass").textContent = formatter(summary?.pass_passengers);
  if ($("cpSumTotal")) $("cpSumTotal").textContent = formatter(summary?.expected_passengers);
  if ($("cpSumTicketPax")) {
    $("cpSumTicketPax").textContent = active && summary
      ? `${Number(summary.ticket_passengers) || 0} ticket passengers`
      : "No active trip";
  }
}

function barcodeMarkup(value) {
  const source = String(value || "ST");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
  }
  const bars = [];
  for (let index = 0; index < 52; index += 1) {
    const bit = ((hash >>> (index % 32)) ^ (index * 7)) & 1;
    bars.push(`<i style="width:${bit ? 3 : 1}px"></i>`);
  }
  return bars.join("");
}

function renderPreview() {
  const container = $("cpPreview");
  if (!container) return;
  const ticket = state.lastTicket;

  if (!ticket) {
    container.innerHTML = `
      <div class="cp-ticket-empty">
        ${icon("ticket")}
        <strong>No ticket selected</strong>
        <p>Issue a ticket or select a recent ticket to preview and print it.</p>
      </div>
    `;
    updateActionState();
    return;
  }

  const bus = state.buses.find((row) => row.id === ticket.bus_id);
  const breakdown = Array.isArray(ticket.passenger_categories) ? ticket.passenger_categories : [];
  const unitFare = breakdown.length === 1 ? Number(breakdown[0].unit_fare) : null;
  const currency = ticket.currency || state.fares?.currency || "INR";
  const issuedAt = ticket.issued_at || ticket.created_at || "";
  const farePerPassenger = unitFare === null
    ? formatMoney((Number(ticket.total_fare) || 0) / Math.max(1, Number(ticket.total_passengers) || 1), currency)
    : formatMoney(unitFare, currency);

  container.innerHTML = `
    <article class="cp-ticket-paper" aria-label="Ticket preview">
      <header class="cp-ticket-head">
        <div class="cp-ticket-mark">ST</div>
        <div>
          <h3>Maharashtra State Transport</h3>
          <p>ST Passenger Ticket</p>
        </div>
        <span class="cp-ticket-copy">CONDUCTOR COPY</span>
      </header>

      <div class="cp-ticket-meta">
        <div><span>Ticket number</span><strong class="cp-mono">${esc(ticket.ticket_number || "Unavailable")}</strong></div>
        <div><span>Date &amp; time</span><strong>${formatDateTime(issuedAt)}</strong></div>
      </div>

      <div class="cp-ticket-grid">
        <div><span>Bus number</span><strong>${esc(bus?.fleet || ticket.bus_id || "Unavailable")}</strong></div>
        <div><span>Registration</span><strong>${esc(ticket.bus_id || "Unavailable")}</strong></div>
        <div><span>Route</span><strong>${esc(ticket.route || state.route || "Unavailable")}</strong></div>
        <div><span>Trip ID</span><strong class="cp-mono">${esc(ticket.trip_id || state.tripId || "Unavailable")}</strong></div>
        <div><span>Boarding stop</span><strong>${esc(ticket.boarding_stop || "Unavailable")}</strong></div>
        <div><span>Destination</span><strong>${esc(ticket.destination_stop || "Unavailable")}</strong></div>
        <div><span>Conductor</span><strong>${esc(ticket.conductor_id || readContext().conductorId || "Unavailable")}</strong></div>
        <div><span>Passenger category</span><strong>${esc(ticketCategories(ticket))}</strong></div>
      </div>

      <div class="cp-ticket-fare">
        <div><span>Passengers</span><strong>${Number(ticket.total_passengers) || 0}</strong></div>
        <div><span>Fare per passenger</span><strong>${farePerPassenger}</strong></div>
        <div class="is-total"><span>Total fare</span><strong>${formatMoney(ticket.total_fare, currency)}</strong></div>
      </div>

      <div class="cp-barcode" aria-label="Barcode-style ticket reference">${barcodeMarkup(ticket.ticket_number)}</div>
      <p class="cp-barcode-value">${esc(ticket.ticket_number || "")}</p>
      <footer class="cp-ticket-foot">Thank you for travelling with MSRTC.</footer>
    </article>
  `;
  updateActionState();
}

function renderAll() {
  renderHeader();
  renderTripCard();
  renderSummaryCards();
  renderCategories();
  renderStops();
  updateFarePreview();
  renderTransactions();
  renderPassengerSummary();
  renderPreview();
  renderMessage();
  updateClock();
}

async function loadBootstrap() {
  setLoading(true);
  setPageAlert("");
  renderAll();
  try {
    const data = await api(API.buses);
    const buses = Array.isArray(data.buses) ? data.buses : [];
    if (!buses.length) {
      setLoading(false);
      renderAll();
      setPageAlert("No buses are registered in the backend database.");
      return;
    }
    state.buses = buses;
    const remembered = buses.find((bus) => bus.id === lastBusId);
    const initial = remembered || buses[0];
    state.busId = initial.id;
    lastBusId = initial.id;
    state.route = initial.route || "";
    state.tripId = initial.default_trip || "";
    state.conductor = initial.operator || "";
    renderAll();
    await loadDashboard();
  } catch (error) {
    setLoading(false);
    renderAll();
    setPageAlert(`Backend unavailable: ${error.message}`);
  }
}

async function loadDashboard() {
  if (!state.busId) return;
  const token = ++state.loadToken;
  const previousTrip = state.tripId;
  setLoading(true);
  renderAll();
  setPageAlert("");

  let activeTrip = null;
  try {
    const active = await api(`${API.activeTrip}?bus_id=${encodeURIComponent(state.busId)}`);
    activeTrip = active.trip || null;
  } catch (error) {
    if (error.status !== 404) {
      if (token !== state.loadToken) return;
      setPageAlert(`Active trip could not be loaded: ${error.message}`);
    }
  }
  if (token !== state.loadToken) return;

  const bus = currentBus();
  state.activeTrip = activeTrip;
  if (activeTrip) {
    state.route = activeTrip.route || bus?.route || state.route;
    state.tripId = activeTrip.trip_id || state.tripId;
    state.conductor = activeTrip.conductor_id || state.conductor || bus?.operator || "";
    state.completedTrip = null;
  } else if (!state.completedTrip) {
    state.route = state.route || bus?.route || "";
    state.tripId = state.tripId || bus?.default_trip || "";
    state.conductor = state.conductor || bus?.operator || "";
  }
  if (previousTrip !== state.tripId) clearRequestId();
  renderTripCard();

  const jobs = [
    ["categories", api(`${API.categories}?include_inactive=true`)],
    ["fares", api(`${API.fares}?route=${encodeURIComponent(state.route)}`)],
    ["stops", api(`${API.routeStops}?route=${encodeURIComponent(state.route)}&bus_id=${encodeURIComponent(state.busId)}`)]
  ];
  if (activeTrip) {
    const summaryQuery = new URLSearchParams({
      bus_id: state.busId,
      trip_id: state.tripId,
      route: state.route
    });
    const eventQuery = new URLSearchParams({
      bus_id: state.busId,
      trip_id: state.tripId,
      limit: "50"
    });
    jobs.push(["summary", api(`${API.ticketingSummary}?${summaryQuery.toString()}`)]);
    jobs.push(["tickets", api(`${API.tickets}?${eventQuery.toString()}`)]);
    jobs.push(["passes", api(`${API.passes}?${eventQuery.toString()}`)]);
  }

  const results = await Promise.allSettled(jobs.map(([, promise]) => promise));
  if (token !== state.loadToken) return;
  const data = Object.fromEntries(jobs.map(([name], index) => [name, results[index]]));

  if (data.categories.status === "fulfilled") {
    state.categories = (Array.isArray(data.categories.value.categories) ? data.categories.value.categories : [])
      .filter((category) => category.active !== false);
  }
  if (data.fares.status === "fulfilled") {
    state.fares = data.fares.value.fares || null;
  }
  if (data.stops.status === "fulfilled") {
    state.stops = Array.isArray(data.stops.value.stops) ? data.stops.value.stops : [];
  }
  if (activeTrip) {
    state.summary = data.summary?.status === "fulfilled" ? data.summary.value.summary || null : null;
    state.tickets = data.tickets?.status === "fulfilled" && Array.isArray(data.tickets.value.tickets)
      ? data.tickets.value.tickets
      : [];
    state.passes = data.passes?.status === "fulfilled" && Array.isArray(data.passes.value.passes)
      ? data.passes.value.passes
      : [];
  } else {
    state.summary = null;
    state.tickets = [];
    state.passes = [];
  }

  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    const reason = failures[0].reason?.message || "Some ETM data could not be loaded.";
    setPageAlert(`Some ETM data could not be loaded: ${reason}`);
  }

  setLoading(false);
  renderAll();
}

async function refreshDashboard() {
  if (state.refreshing || state.loading || state.busy || !state.busId || document.hidden) return;
  state.refreshing = true;
  const token = state.loadToken;
  const busId = state.busId;

  try {
    let activeTrip = null;
    try {
      const active = await api(`${API.activeTrip}?bus_id=${encodeURIComponent(busId)}`);
      activeTrip = active.trip || null;
    } catch (error) {
      if (error.status !== 404) return;
    }
    if (token !== state.loadToken || busId !== state.busId) return;

    if (!activeTrip) {
      if (state.activeTrip) {
        state.activeTrip = null;
        state.summary = null;
        state.tickets = [];
        state.passes = [];
        renderTripCard();
        renderSummaryCards();
        renderTransactions();
        renderPassengerSummary();
        updateActionState();
      }
      return;
    }

    if (!state.activeTrip || state.activeTrip.id !== activeTrip.id) {
      await loadDashboard();
      return;
    }

    state.activeTrip = activeTrip;
    const summaryQuery = new URLSearchParams({
      bus_id: busId,
      trip_id: state.tripId,
      route: state.route
    });
    const eventQuery = new URLSearchParams({
      bus_id: busId,
      trip_id: state.tripId,
      limit: "50"
    });
    const [summary, tickets, passes] = await Promise.all([
      api(`${API.ticketingSummary}?${summaryQuery.toString()}`),
      api(`${API.tickets}?${eventQuery.toString()}`),
      api(`${API.passes}?${eventQuery.toString()}`)
    ]);
    if (token !== state.loadToken || busId !== state.busId) return;

    state.summary = summary.summary || state.summary;
    state.tickets = Array.isArray(tickets.tickets) ? tickets.tickets : [];
    state.passes = Array.isArray(passes.passes) ? passes.passes : [];
    renderTripCard();
    renderSummaryCards();
    renderTransactions();
    renderPassengerSummary();
  } catch {
    // Background refresh is best-effort; actionable changes surface through form actions.
  } finally {
    state.refreshing = false;
  }
}

function changeBus(busId) {
  if (state.busy) return;
  const bus = state.buses.find((row) => row.id === busId);
  if (!bus || bus.id === state.busId) return;
  state.busId = bus.id;
  lastBusId = bus.id;
  state.route = bus.route || "";
  state.tripId = bus.default_trip || "";
  state.conductor = bus.operator || "";
  state.activeTrip = null;
  state.completedTrip = null;
  state.summary = null;
  state.tickets = [];
  state.passes = [];
  state.stops = [];
  state.lastTicket = null;
  state.selectedTicketId = null;
  state.lastPass = null;
  state.showAllTransactions = false;
  state.requestId = "";
  setMessage("");
  renderAll();
  loadDashboard();
}

function selectCategory(code) {
  if (!state.categories.some((category) => category.code === code)) return;
  state.selectedCategory = code;
  clearRequestId();
  renderCategories();
  updateFarePreview();
}

function setQuantity(next) {
  const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.trunc(Number(next) || 1)));
  state.quantity = quantity;
  if ($("cpQty")) $("cpQty").value = String(quantity);
  clearRequestId();
  updateFarePreview();
}

function switchMode(mode) {
  state.mode = mode === "pass" ? "pass" : "ticket";
  document.querySelectorAll("[data-cp-tab]").forEach((button) => {
    const selected = button.dataset.cpTab === state.mode;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  if ($("cpTicketPanel")) $("cpTicketPanel").hidden = state.mode !== "ticket";
  if ($("cpPassPanel")) $("cpPassPanel").hidden = state.mode !== "pass";
  setMessage("");
}

function clearTicketForm() {
  state.selectedCategory = orderedCategories()[0]?.code || "FULL";
  state.quantity = 1;
  if ($("cpQty")) $("cpQty").value = "1";
  if (state.stops.length) {
    if ($("cpBoarding")) $("cpBoarding").value = state.stops[0];
    if ($("cpDestination")) $("cpDestination").value = state.stops[state.stops.length - 1] || state.stops[0];
  }
  state.requestId = "";
  setMessage("");
  renderCategories();
  updateFarePreview();
}

function defaultPassStart() {
  return new Date().toISOString().slice(0, 10);
}

function defaultPassExpiry() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
}

function resetPassForm() {
  if ($("cpPassId")) $("cpPassId").value = "";
  if ($("cpPassType")) $("cpPassType").value = "Monthly Pass";
  if ($("cpPassCount")) $("cpPassCount").value = "1";
  if ($("cpPassValidFrom")) $("cpPassValidFrom").value = defaultPassStart();
  if ($("cpPassValidUntil")) $("cpPassValidUntil").value = defaultPassExpiry();
  if ($("cpPassBoarding")) $("cpPassBoarding").value = state.stops[0] || "";
  if ($("cpPassDestination")) $("cpPassDestination").value = state.stops[state.stops.length - 1] || "";
  if ($("cpPassRemarks")) $("cpPassRemarks").value = "";
}

async function loadTicketPreview(id) {
  if (!id || state.busy) return;
  try {
    setMessage("Loading ticket preview.", "info");
    const data = await api(`${API.tickets}/${encodeURIComponent(id)}`);
    state.lastTicket = data.ticket || null;
    state.selectedTicketId = data.ticket?.id ?? null;
    renderPreview();
    setMessage(`Showing ticket ${data.ticket?.ticket_number || id}.`, "info");
  } catch (error) {
    setMessage(`Ticket preview could not be loaded: ${error.message}`, "error");
  }
}

async function startTrip() {
  if (state.busy || hasActiveTrip()) return;
  const context = readContext();
  if (!context.busId || !context.route || !context.tripId) {
    setMessage("Select a bus, route and trip before starting the trip.", "error");
    return;
  }
  setBusy(true);
  setMessage("Starting trip.", "info");
  try {
    const data = await api(API.trips, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bus_id: context.busId,
        route: context.route,
        trip_id: context.tripId,
        conductor_id: context.conductorId
      })
    });
    state.activeTrip = data.trip || null;
    state.completedTrip = null;
    state.requestId = "";
    setMessage(`Trip ${context.tripId} is now active.`, "success");
    showToast(`Trip ${context.tripId} started.`);
    await loadDashboard();
  } catch (error) {
    setMessage(`Trip could not be started: ${error.message}`, "error");
  } finally {
    setBusy(false);
    renderTripCard();
  }
}

async function completeTrip() {
  if (state.busy || !hasActiveTrip()) return;
  if (!window.confirm(`Complete trip ${state.tripId}? New tickets and passes will be blocked until a new trip is started.`)) {
    return;
  }
  setBusy(true);
  setMessage("Completing trip.", "info");
  try {
    const data = await api(`${API.trips}/${encodeURIComponent(state.activeTrip.id)}/complete`, {
      method: "POST"
    });
    state.completedTrip = data.trip || state.activeTrip;
    state.tripId = state.completedTrip.trip_id || state.tripId;
    state.route = state.completedTrip.route || state.route;
    state.activeTrip = null;
    state.requestId = "";
    setMessage(`Trip ${state.tripId} completed.`, "success");
    showToast(`Trip ${state.tripId} completed.`);
    renderAll();
  } catch (error) {
    setMessage(`Trip could not be completed: ${error.message}`, "error");
  } finally {
    setBusy(false);
    renderAll();
  }
}

async function issueTicket() {
  if (state.busy) return;
  const context = readContext();
  const category = currentCategory();
  const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.trunc(Number(state.quantity) || 1)));
  const boarding = ($("cpBoarding")?.value || "").trim();
  const destination = ($("cpDestination")?.value || "").trim();

  if (!hasActiveTrip()) {
    setMessage("Start the trip before issuing tickets.", "error");
    return;
  }
  if (!context.busId || !context.route || !context.tripId) {
    setMessage("Bus, route and trip details are required before issuing a ticket.", "error");
    return;
  }
  if (!category) {
    setMessage("Select a passenger category.", "error");
    return;
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    setMessage("Number of passengers must be a positive whole number.", "error");
    return;
  }
  if (!boarding || !destination) {
    setMessage("Select both a boarding stop and a destination stop.", "error");
    return;
  }
  if (boarding === destination) {
    setMessage("Destination stop must be different from the boarding stop.", "error");
    return;
  }

  setBusy(true);
  setMessage("Issuing ticket.", "info");
  try {
    const data = await api(API.tickets, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bus_id: context.busId,
        route: context.route,
        trip_id: context.tripId,
        conductor_id: context.conductorId,
        boarding_stop: boarding,
        destination_stop: destination,
        items: [{ category_code: category.code, quantity }],
        client_request_id: makeRequestId()
      })
    });
    state.requestId = "";
    state.summary = data.summary || state.summary;
    state.lastTicket = data.ticket || null;
    state.selectedTicketId = data.ticket?.id ?? null;
    state.quantity = 1;
    if ($("cpQty")) $("cpQty").value = "1";
    setMessage(
      data.duplicate
        ? `Ticket ${data.ticket.ticket_number} was already recorded for this submission.`
        : `Ticket ${data.ticket.ticket_number} issued for ${data.ticket.total_passengers} passenger(s).`,
      "success"
    );
    showToast(`Ticket ${data.ticket.ticket_number} issued.`);
    renderCategories();
    renderPreview();
    await loadDashboard();
  } catch (error) {
    setMessage(`Ticket was not issued: ${error.message}`, "error");
  } finally {
    setBusy(false);
    updateFarePreview();
  }
}

async function registerPass() {
  if (state.busy) return;
  const context = readContext();
  const passNumber = ($("cpPassId")?.value || "").trim();
  const passType = ($("cpPassType")?.value || "").trim();
  const passengerCount = Math.trunc(Number($("cpPassCount")?.value) || 0);
  const boarding = ($("cpPassBoarding")?.value || "").trim();
  const destination = ($("cpPassDestination")?.value || "").trim();
  const validFrom = ($("cpPassValidFrom")?.value || "").trim();
  const validUntil = ($("cpPassValidUntil")?.value || "").trim();

  if (!hasActiveTrip()) {
    setMessage("Start the trip before registering passes.", "error");
    return;
  }
  if (!passType) {
    setMessage("Select a pass category.", "error");
    return;
  }
  if (!Number.isInteger(passengerCount) || passengerCount < 1) {
    setMessage("Passengers covered must be a positive whole number.", "error");
    return;
  }
  if (!boarding || !destination) {
    setMessage("Select both boarding and destination stops for the pass.", "error");
    return;
  }
  if (boarding === destination) {
    setMessage("Pass destination must be different from the boarding stop.", "error");
    return;
  }
  if (validFrom && validUntil && validUntil < validFrom) {
    setMessage("Pass validity end cannot be earlier than its start date.", "error");
    return;
  }

  setBusy(true);
  setMessage("Registering pass passenger.", "info");
  try {
    const data = await api(API.passes, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bus_id: context.busId,
        route: context.route,
        trip_id: context.tripId,
        conductor_id: context.conductorId,
        pass_number: passNumber,
        pass_type: passType,
        passenger_count: passengerCount,
        valid_from: validFrom,
        valid_until: validUntil,
        boarding_stop: boarding,
        destination_stop: destination,
        notes: ($("cpPassRemarks")?.value || "").trim()
      })
    });
    state.summary = data.summary || state.summary;
    state.lastPass = data.pass || null;
    resetPassForm();
    setMessage(
      `Pass ${data.pass.pass_number} registered for ${data.pass.passenger_count} passenger(s).`,
      "success"
    );
    showToast(`Pass ${data.pass.pass_number} registered.`);
    await loadDashboard();
  } catch (error) {
    setMessage(`Pass was not registered: ${error.message}`, "error");
  } finally {
    setBusy(false);
    updateFarePreview();
  }
}

export function renderConductorPanel() {
  return `
    <div class="cp-dashboard" id="cpDashboard" aria-busy="true">
      <div class="cp-page-alert" id="cpPageAlert" role="alert" hidden></div>

      <header class="cp-hero">
        <div class="cp-hero-copy">
          <span class="cp-kicker">Conductor workspace</span>
          <h1>Conductor Panel</h1>
          <p>Issue tickets, register pass passengers and manage current trip.</p>
        </div>
        <div class="cp-hero-tools">
          <div class="cp-clock" aria-label="Current date and time">
            <span class="cp-tool-icon">${icon("calendar")}</span>
            <div id="cpClock"><span>Loading date</span><strong>--:--</strong></div>
          </div>
          <span class="cp-header-status is-idle" id="cpHeaderStatus"><i></i><span id="cpHeaderStatusText">No active trip</span></span>
          <div class="cp-conductor-chip">
            <span class="cp-avatar" id="cpConductorAvatar">ST</span>
            <div>
              <strong id="cpConductorChipName">Unassigned</strong>
              <span id="cpConductorChipId">Conductor ID unavailable</span>
            </div>
          </div>
        </div>
      </header>

      <section class="cp-trip-card" aria-labelledby="cpTripCardTitle">
        <h2 class="cp-sr-only" id="cpTripCardTitle">Active bus and trip information</h2>

        <div class="cp-trip-section">
          <span class="cp-trip-icon is-blue">${icon("bus")}</span>
          <div class="cp-trip-copy">
            <span class="cp-trip-label">Bus Number</span>
            <strong id="cpBusNumber">Not assigned</strong>
            <small id="cpBusReg">Registration unavailable</small>
            <select class="cp-bus-switch" id="cpBusSelect" aria-label="Switch bus"></select>
          </div>
        </div>

        <div class="cp-trip-section">
          <span class="cp-trip-icon is-orange">${icon("route")}</span>
          <div class="cp-trip-copy">
            <span class="cp-trip-label">Route</span>
            <strong id="cpRouteName">Not assigned</strong>
            <small id="cpRouteNumber">Route number unavailable</small>
            <span class="cp-trip-ends" id="cpRouteEnds">Source and destination unavailable</span>
          </div>
        </div>

        <div class="cp-trip-section">
          <span class="cp-trip-icon is-pink">${icon("ticket")}</span>
          <div class="cp-trip-copy">
            <span class="cp-trip-label">Trip ID</span>
            <input class="cp-trip-input cp-mono" id="cpTripId" maxlength="50" autocomplete="off" aria-label="Trip ID" placeholder="Not assigned" />
            <small id="cpTripStart">Trip has not started</small>
          </div>
        </div>

        <div class="cp-trip-section">
          <span class="cp-trip-icon is-green">${icon("user")}</span>
          <div class="cp-trip-copy">
            <span class="cp-trip-label">Conductor</span>
            <input class="cp-trip-input" id="cpConductorId" maxlength="100" autocomplete="off" aria-label="Conductor ID or name" placeholder="Not assigned" />
            <small id="cpConductorMeta">Conductor ID unavailable</small>
          </div>
        </div>

        <div class="cp-trip-section is-status">
          <span class="cp-trip-icon is-slate">${icon("check")}</span>
          <div class="cp-trip-copy">
            <span class="cp-trip-label">Trip Status</span>
            <span class="cp-status-badge is-not-started" id="cpTripStatusBadge">Not started</span>
            <small id="cpTripStatusMeta">Start the trip before issuing tickets.</small>
            <div class="cp-trip-actions">
              <button class="cp-btn cp-btn-primary cp-btn-small" id="cpStartTripBtn" type="button">Start trip</button>
              <button class="cp-btn cp-btn-ghost cp-btn-small" id="cpCompleteTripBtn" type="button" hidden>Complete trip</button>
            </div>
          </div>
        </div>
      </section>

      <section class="cp-stat-grid" aria-label="Passenger and fare summary">
        <article class="cp-stat-card">
          <span class="cp-stat-icon is-blue">${icon("users")}</span>
          <div>
            <span class="cp-stat-label">Total Passengers</span>
            <strong id="cpStatExpected">Loading</strong>
            <small>Expected onboard from ETM records</small>
          </div>
        </article>
        <article class="cp-stat-card">
          <span class="cp-stat-icon is-green">${icon("ticket")}</span>
          <div>
            <span class="cp-stat-label">Tickets Issued</span>
            <strong id="cpStatTickets">Loading</strong>
            <small>Ticket transactions on this trip</small>
          </div>
        </article>
        <article class="cp-stat-card">
          <span class="cp-stat-icon is-orange">${icon("pass")}</span>
          <div>
            <span class="cp-stat-label">Pass Passengers</span>
            <strong id="cpStatPassengers">Loading</strong>
            <small>Passengers with a valid registered pass</small>
          </div>
        </article>
        <article class="cp-stat-card">
          <span class="cp-stat-icon is-pink">${icon("rupee")}</span>
          <div>
            <span class="cp-stat-label">Total Fare Collected</span>
            <strong id="cpStatFare">Loading</strong>
            <small>Ticket revenue for this trip</small>
          </div>
        </article>
      </section>

      <section class="cp-workspace">
        <div class="cp-workspace-main">
          <section class="cp-card cp-counter-card" aria-labelledby="cpCounterTitle">
            <div class="cp-card-head">
              <div>
                <h2 id="cpCounterTitle">Ticket Counter</h2>
                <p>Issue a passenger ticket or register an existing pass.</p>
              </div>
              <span class="cp-live-pill"><i></i> ETM live</span>
            </div>

            <div class="cp-tabs" role="tablist" aria-label="Ticket counter options">
              <button class="cp-tab is-active" type="button" role="tab" aria-selected="true" aria-controls="cpTicketPanel" data-cp-tab="ticket">${icon("ticket")} Issue Ticket</button>
              <button class="cp-tab" type="button" role="tab" aria-selected="false" aria-controls="cpPassPanel" data-cp-tab="pass">${icon("pass")} Add Pass Passenger</button>
            </div>

            <div class="cp-message is-info" id="cpFormMessage" role="status" aria-live="polite" hidden></div>

            <div class="cp-tab-panel" id="cpTicketPanel" role="tabpanel">
              <div class="cp-section-heading">
                <div>
                  <h3>Passenger category</h3>
                  <p>Fare follows the configured route fare table.</p>
                </div>
                <span class="cp-hint">Select one category</span>
              </div>

              <div class="cp-category-grid" id="cpCategories" role="radiogroup" aria-label="Passenger category"></div>

              <div class="cp-ticket-form-grid">
                <div class="cp-field">
                  <label for="cpQty">Number of Passengers</label>
                  <div class="cp-qty">
                    <button type="button" id="cpQtyMinus" aria-label="Decrease passenger count">${icon("minus")}</button>
                    <input id="cpQty" type="number" min="1" max="${MAX_QUANTITY}" step="1" inputmode="numeric" value="1" aria-label="Number of passengers" />
                    <button type="button" id="cpQtyPlus" aria-label="Increase passenger count">${icon("plus")}</button>
                  </div>
                </div>

                <div class="cp-field">
                  <label for="cpBoarding">Boarding Stop</label>
                  <select id="cpBoarding" class="cp-select"></select>
                </div>

                <div class="cp-field">
                  <label for="cpDestination">Destination Stop</label>
                  <select id="cpDestination" class="cp-select"></select>
                </div>
              </div>

              <p class="cp-inline-error" id="cpStopValidation" hidden></p>

              <div class="cp-fare-panel">
                <div class="cp-fare-line">
                  <div>
                    <span>Fare per Passenger</span>
                    <strong id="cpFarePer">Unavailable</strong>
                  </div>
                  <div class="cp-fare-divider"></div>
                  <div>
                    <span>Total Fare</span>
                    <strong class="cp-total-fare" id="cpTotalFare">Unavailable</strong>
                  </div>
                </div>
                <div class="cp-fare-meta">
                  <span id="cpFareBreakdown">Select a passenger category.</span>
                  <small id="cpFareSource">Route fare settings are unavailable.</small>
                </div>
              </div>

              <div class="cp-form-actions">
                <button class="cp-btn cp-btn-primary" id="cpIssueBtn" type="button">${icon("ticket")} Issue Ticket</button>
                <button class="cp-btn cp-btn-ghost" id="cpClearBtn" type="button">Clear</button>
              </div>
            </div>

            <div class="cp-tab-panel" id="cpPassPanel" role="tabpanel" hidden>
              <div class="cp-section-heading">
                <div>
                  <h3>Pass passenger details</h3>
                  <p>Valid pass passengers increase expected passengers without adding fare revenue.</p>
                </div>
                <span class="cp-hint">Pass ID is optional</span>
              </div>

              <div class="cp-pass-grid">
                <div class="cp-field">
                  <label for="cpPassId">Pass ID</label>
                  <input id="cpPassId" class="cp-input cp-mono" type="text" maxlength="60" placeholder="Auto-generated if blank" autocomplete="off" />
                </div>
                <div class="cp-field">
                  <label for="cpPassType">Pass Category</label>
                  <select id="cpPassType" class="cp-select">
                    <option>Monthly Pass</option>
                    <option>Student Pass</option>
                    <option>Senior Citizen Pass</option>
                    <option>Staff Pass</option>
                    <option>Other</option>
                  </select>
                </div>
                <div class="cp-field">
                  <label for="cpPassCount">Passengers Covered</label>
                  <input id="cpPassCount" class="cp-input" type="number" min="1" max="${MAX_QUANTITY}" step="1" inputmode="numeric" value="1" />
                </div>
                <div class="cp-field">
                  <label for="cpPassValidFrom">Valid From</label>
                  <input id="cpPassValidFrom" class="cp-input" type="date" />
                </div>
                <div class="cp-field">
                  <label for="cpPassValidUntil">Valid Until</label>
                  <input id="cpPassValidUntil" class="cp-input" type="date" />
                </div>
                <div class="cp-field">
                  <label for="cpPassBoarding">Boarding Stop</label>
                  <select id="cpPassBoarding" class="cp-select"></select>
                </div>
                <div class="cp-field">
                  <label for="cpPassDestination">Destination Stop</label>
                  <select id="cpPassDestination" class="cp-select"></select>
                </div>
                <div class="cp-field cp-field-wide">
                  <label for="cpPassRemarks">Remarks <span>(optional)</span></label>
                  <textarea id="cpPassRemarks" class="cp-textarea" maxlength="500" rows="3" placeholder="Operational remarks only; do not enter personal passenger details."></textarea>
                </div>
              </div>

              <div class="cp-form-actions">
                <button class="cp-btn cp-btn-primary" id="cpPassBtn" type="button">${icon("pass")} Register Pass</button>
                <button class="cp-btn cp-btn-ghost" id="cpPassClearBtn" type="button">Clear</button>
              </div>
            </div>
          </section>

          <section class="cp-card" aria-labelledby="cpRecentTitle">
            <div class="cp-card-head">
              <div>
                <h2 id="cpRecentTitle">Recent Transactions</h2>
                <p id="cpTxCount">Loading transactions</p>
              </div>
              <button class="cp-link-btn" id="cpTxViewAll" type="button" hidden>View all</button>
            </div>

            <div class="cp-table-wrap">
              <table class="cp-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Type</th>
                    <th>Ticket / Pass ID</th>
                    <th>Passenger Category</th>
                    <th>Passengers</th>
                    <th>Fare</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody id="cpTxBody">
                  <tr><td colspan="7"><div class="cp-table-loading"><span></span><span></span><span></span></div></td></tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside class="cp-workspace-side">
          <section class="cp-card cp-preview-card" aria-labelledby="cpPreviewTitle">
            <div class="cp-card-head">
              <div>
                <h2 id="cpPreviewTitle">Ticket Preview</h2>
                <p>Latest issued or selected ticket</p>
              </div>
              <button class="cp-btn cp-btn-ghost cp-btn-small" id="cpPrintBtn" type="button" disabled>${icon("print")} Print</button>
            </div>
            <div class="cp-preview" id="cpPreview">
              <div class="cp-ticket-empty">
                ${icon("ticket")}
                <strong>No ticket selected</strong>
                <p>Issue a ticket or select a recent ticket to preview and print it.</p>
              </div>
            </div>
          </section>

          <section class="cp-card" aria-labelledby="cpPassengerSummaryTitle">
            <div class="cp-card-head">
              <div>
                <h2 id="cpPassengerSummaryTitle">Passenger Summary</h2>
                <p>Current trip · actual passengers represented</p>
              </div>
              <span class="cp-mini-pill">ETM</span>
            </div>

            <div class="cp-passenger-summary">
              <div class="cp-pax-row"><span><i class="is-blue"></i>Full-Fare Passengers</span><strong id="cpSumFull">—</strong></div>
              <div class="cp-pax-row"><span><i class="is-pink"></i>Half-Fare Passengers</span><strong id="cpSumHalf">—</strong></div>
              <div class="cp-pax-row"><span><i class="is-green"></i>Free-Fare Passengers</span><strong id="cpSumFree">—</strong></div>
              <div class="cp-pax-row"><span><i class="is-orange"></i>Pass Passengers</span><strong id="cpSumPass">—</strong></div>
              <div class="cp-pax-total">
                <div>
                  <span>Total Expected Passengers</span>
                  <small id="cpSumTicketPax">No active trip</small>
                </div>
                <strong id="cpSumTotal">—</strong>
              </div>
              <p class="cp-summary-note">${icon("info")} Expected passengers come from valid ticket and pass records. They are not a camera frame count.</p>
            </div>
          </section>
        </aside>
      </section>
    </div>
  `;
}

export function wireConductorPanelControls() {
  resetState();
  const previousClock = state.clockTimer;
  const previousRefresh = state.refreshTimer;
  if (previousClock) clearInterval(previousClock);
  if (previousRefresh) clearInterval(previousRefresh);

  $("cpBusSelect")?.addEventListener("change", (event) => changeBus(event.target.value));
  $("cpTripId")?.addEventListener("input", (event) => {
    state.tripId = event.target.value;
    clearRequestId();
    renderHeader();
    updateActionState();
  });
  $("cpConductorId")?.addEventListener("input", (event) => {
    state.conductor = event.target.value;
    renderHeader();
  });
  $("cpStartTripBtn")?.addEventListener("click", startTrip);
  $("cpCompleteTripBtn")?.addEventListener("click", completeTrip);
  $("cpPrintBtn")?.addEventListener("click", () => window.print());

  document.querySelectorAll("[data-cp-tab]").forEach((button) => {
    button.addEventListener("click", () => switchMode(button.dataset.cpTab));
  });

  $("cpCategories")?.addEventListener("click", (event) => {
    const category = event.target.closest("[data-category]");
    if (category) selectCategory(category.dataset.category);
  });

  $("cpQtyMinus")?.addEventListener("click", () => setQuantity(state.quantity - 1));
  $("cpQtyPlus")?.addEventListener("click", () => setQuantity(state.quantity + 1));
  $("cpQty")?.addEventListener("input", (event) => {
    const raw = Math.trunc(Number(event.target.value) || 0);
    state.quantity = Math.max(1, Math.min(MAX_QUANTITY, raw || 1));
    clearRequestId();
    updateFarePreview();
  });
  $("cpQty")?.addEventListener("blur", (event) => {
    event.target.value = String(state.quantity);
  });

  ["cpBoarding", "cpDestination"].forEach((id) => {
    $(id)?.addEventListener("change", () => {
      clearRequestId();
      renderStopValidation();
    });
  });
  ["cpPassBoarding", "cpPassDestination"].forEach((id) => {
    $(id)?.addEventListener("change", () => clearRequestId());
  });

  $("cpIssueBtn")?.addEventListener("click", issueTicket);
  $("cpClearBtn")?.addEventListener("click", clearTicketForm);
  $("cpPassBtn")?.addEventListener("click", registerPass);
  $("cpPassClearBtn")?.addEventListener("click", () => {
    resetPassForm();
    setMessage("");
  });

  $("cpTxViewAll")?.addEventListener("click", () => {
    state.showAllTransactions = !state.showAllTransactions;
    renderTransactions();
  });

  const transactionBody = $("cpTxBody");
  transactionBody?.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-ticket-id]");
    if (row) loadTicketPreview(row.dataset.ticketId);
  });
  transactionBody?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr[data-ticket-id]");
    if (!row) return;
    event.preventDefault();
    loadTicketPreview(row.dataset.ticketId);
  });

  state.clockTimer = setInterval(updateClock, 1000);
  state.refreshTimer = setInterval(refreshDashboard, REFRESH_INTERVAL_MS);
  updateClock();
  resetPassForm();
  renderAll();
  window.__stopConductorPolling = cleanupConductorPanel;
  loadBootstrap();
}

export function cleanupConductorPanel() {
  if (state.clockTimer) {
    clearInterval(state.clockTimer);
    state.clockTimer = null;
  }
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
  state.refreshing = false;
  state.loadToken += 1;
  if (window.__stopConductorPolling === cleanupConductorPanel) {
    window.__stopConductorPolling = null;
  }
}
