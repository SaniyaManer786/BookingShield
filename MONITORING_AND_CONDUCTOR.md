# Monitoring, ETM and Conductor Workflows (v1.19.4)

Documentation for the backend-connected SMART ST Control Center workflows:

- **Computer Vision Monitoring** - browser camera with real YOLOv8 person detection.
- **Conductor Panel** - ETM fares, ticket issuance, pass registration, CDV comparison and checkpoint submission.
- **Mismatch Alerts** - backend alert records with review/resolve actions.
- **Passenger Analytics** - backend ETM, checkpoint, alert and inspection aggregates.
- **Checker Dispatch** and **Inspection History** - real checker roster, assignments, completion outcomes and history.

These workflows share one camera session, one inference loop, one active bus and one SQLite database. They are backed by the FastAPI service in `backend/main.py` and `backend/data/conductor.db`.

> The Overview, Live Bus Monitoring and Bus & Route Management screens still contain clearly labelled sample data. Alerts, analytics, dispatch, inspection history and conductor ETM records use backend persistence.

---

## 1. Architecture Overview

```
Browser (React/Vite)
├── Computer Vision Monitoring  src/computerVision.js
│   └── shared camera + inference service  src/visionCamera.js
│        ├── getUserMedia() single MediaStream
│        ├── capture frame → POST /api/detect
│        └── heartbeat → POST /api/vision/session
│
├── Conductor Panel  src/conductorPanel.js
│    ├── loads buses/routes/checkpoints/fares from API
│    ├── issues tickets and registers passes
│    ├── polls GET /api/conductor/camera-state every 2.5 s
│    └── POST /api/conductor/checkpoint on submit
│
└── Control-room pages  app.js
     ├── Mismatch Alerts → /api/alerts
     ├── Passenger Analytics → /api/analytics/passengers
     ├── Checker Dispatch → /api/checkers + /api/checker-dispatches
     └── Inspection History → /api/inspections

FastAPI backend  backend/main.py
├── conductor_db.py   checkpoint/camera/bus/ETM snapshot persistence
├── etm_db.py         fares, tickets, passes, summaries, analytics
└── alert_dispatch.py mismatch alert + checker dispatch + inspections

SQLite  backend/data/conductor.db
```

### Shared vision camera service

`src/visionCamera.js` is the single owner of the webcam. It guarantees:

- Exactly **one** `MediaStream`, shared by every attached `<video>` element.
- Exactly **one** inference loop posting frames to `POST /api/detect`.
- Exactly **one active bus** (`getActiveBusId` / `setActiveBusId`).
- A camera session heartbeat every 15 seconds.
- Reference-counted page consumers: navigating between Computer Vision Monitoring and Conductor Panel does not restart the camera. The camera stops only when the last consumer leaves.

The passenger count is always produced by the backend OpenCV/YOLO pipeline. The frontend never invents or estimates a count.

---

## 2. Computer Vision Monitoring

Source: `src/computerVision.js`

### Purpose

Starts the browser camera, sends frames to the backend for YOLO person detection, draws bounding boxes, and shows the current-frame people count.

### UI sections

| Section | Contents |
| --- | --- |
| Summary cards | People detected, camera status, model status |
| Controls | Start, Stop, Restart, bus selector, camera device selector, link to Conductor Panel |
| Live preview | `<video>` with overlay `<canvas>` for bounding boxes and person labels |

### Controls

- **Allow Camera & Start Monitoring** — requests camera permission and starts inference.
- **Stop Camera** — stops the stream and inference loop, clears the current count.
- **Restart Camera** — stops and restarts on the selected device.
- **Bus selector** — sets the shared active bus; populated from `GET /api/conductor/buses`.
- **Camera selector** — lists `videoinput` devices from `navigator.mediaDevices.enumerateDevices()`.

### Inference behavior

- Frames are captured at a maximum width of **640 px** and sent as JPEG (`quality 0.8`).
- Only one frame is in flight at a time; the next frame starts after the previous response.
- Idle gap between completed inferences is **60 ms**.
- Each request enables `track: true` (ByteTrack) so the backend can de-duplicate the same person across frames.
- The displayed number is the **number of people visible in the latest frame**, not a cumulative onboard counter.
- Backend tracker state is reset when the camera starts or when the active bus changes.
- Detection responses from a stopped/restarted camera or a previous bus are discarded.

### Camera status values

`idle`, `connecting`, `connected`, `permission_denied`, `unavailable`, `error`.

Model status values: `loading`, `ready`, `error`.

### Error handling

- Camera permission, missing device, device-in-use and constraint errors are mapped to readable messages.
- Camera stream ending mid-session (unplugged/closed) stops the loop and clears the count.
- Backend unreachable or model missing is shown in the detection/model status cards and an error banner.

---

## 3. Conductor Panel

Source: `src/conductorPanel.js`

### Purpose

Lets a conductor configure route fares, issue ticket transactions, register valid passes, record trip details at a checkpoint, compare the ticketing total with the live camera estimate, and persist the checkpoint to the backend.

### Section A — Trip details

Fields are populated from the backend, not invented in the browser:

- **Bus registration** — `GET /api/conductor/buses`
- **Route** — `GET /api/conductor/routes`
- **Current checkpoint** — `GET /api/conductor/checkpoint-options`, filtered by bus and route
- **Trip ID** — prefilled from the bus `default_trip`
- **Conductor ID** — prefilled from the bus `operator`

The first checkpoint and every bus change start with empty count fields. Previous saved counts are never copied automatically.

Trip lifecycle — `POST /api/conductor/trips` starts an Active trip for a registered bus and route. Ticket issuance, pass registration and checkpoint submission also create the trip automatically when it does not exist. Starting the same bus/trip again is idempotent; a different route for the same active trip is rejected. A bus can have only one Active trip at a time, so starting a different trip before completing the current one is rejected.

### Section A2 — ETM fares, tickets and passes

The ETM block is scoped to the selected bus, route and trip. Records are written through the backend; the UI never substitutes sample ticketing totals. The active-trip strip shows whether the selected bus already has an Active trip and can start one explicitly; issuing a ticket also creates the trip if needed. If the selected bus already has an Active trip, the panel automatically aligns the route and Trip ID to that trip so tickets and passes are issued against the correct `bus_trip_id`.

**Fares** — `GET/POST /api/conductor/fares?route=...`

- Full fare must be greater than zero.
- Half fare must be non-negative and cannot exceed the full fare.
- Free fare is fixed at `0`.
- Defaults before configuration: full `120`, half `60`, free `0`, currency `INR`.

**Passenger categories** — `GET/POST /api/conductor/passenger-categories`

- Categories are backend-configured with a unique code, label, fare basis (`full`, `half` or `free`), sort order and active flag.
- The seeded defaults are `FULL`, `HALF` and `FREE`. Seeding uses `ON CONFLICT DO NOTHING`, so an operator's label, basis, order or active-state edits survive startup.
- New categories can be added from the collapsible category editor; existing rows can change their label, fare basis or active status and save individually.
- At least one category must remain active.
- Category codes are normalised to uppercase letters, numbers and underscores.

**Route stops** — `GET /api/conductor/route-stops?route=...&bus_id=...`

- Returns the route endpoints plus checkpoint names already recorded for that route.
- Route strings are split on a spaced hyphen, en dash or em dash; no stop names are invented.
- Stops are suggested for the boarding/destination selectors. Ticket issuance does not require a stop, preserving compatibility with routes that have only one known endpoint.

**Tickets** — `GET/POST /api/conductor/tickets`, `GET /api/conductor/tickets/{id}` and `POST /api/conductor/tickets/{id}/cancel`

- Each issuance is a separate transaction. The preferred payload is `items: [{category_code, quantity}]`; legacy `full_count`/`half_count`/`free_count` payloads remain supported.
- Ticket numbers are generated as `ST-YYYYMMDD-NNNNN`; the backend enforces uniqueness.
- Fare is calculated from the route settings and the category's fare basis, then stored with the transaction.
- Each line item snapshots the category code, label and fare basis alongside passenger count, unit fare and line total, so later category edits do not rewrite issued tickets.
- `boarding_stop` and `destination_stop` are stored with the ticket when supplied.
- Every ticket and pass stores the internal `bus_trip_id` of its Active trip.
- `client_request_id`, `request_id` or an `Idempotency-Key` header makes issuance retry-safe. Replaying the same request returns the original ticket with `duplicate: true` and HTTP 200; reusing a key for different ticket details, items or stops returns HTTP 409.
- Cancelled tickets remain in history but no longer contribute to valid totals.
- Only `Valid` tickets can be cancelled. History accepts the `status` filter `Valid` or `Cancelled`.
- The UI shows a printable ticket card after issuance and provides View/Print actions for recent tickets. Printing is isolated with print-only CSS.

**Passes** — `GET/POST /api/conductor/passes` and `POST /api/conductor/passes/{id}/cancel`

- Stores pass number, type, passenger count, validity dates and notes.
- Pass numbers are generated as `PS-YYYYMMDD-NNNNN` unless one is supplied.
- A pass contributes to the ETM total only when it is `Valid` and the current UTC date is inside its validity window.

**ETM summary** — `GET /api/conductor/ticketing/summary`

Returns valid ticket passengers, pass passengers, ticket revenue, ticket/pass counts and the expected onboard total for the active bus trip.

When any valid ETM ticket or pass exists for the trip, checkpoint submission uses the ETM totals instead of the manual ticket/pass count fields. If no ETM records exist, manual entry remains available. The chosen source is stored as `ticketing_source = "etm" | "manual"`.

### Section B — Passenger count

Six required whole-number fields, each `0–500`:

| Field | Meaning |
| --- | --- |
| Active tickets | Tickets sold/validated at this checkpoint |
| Valid passes | Valid passenger passes |
| Other authorized passengers | Other authorized occupants |
| Starting onboard count | Passengers onboard at the start of the period |
| Passengers boarded | Boarded since the previous checkpoint |
| Passengers alighted | Alighted since the previous checkpoint |

Also on this section:

- **Live camera passenger estimate** — read-only value from `GET /api/conductor/camera-state`.
- **Notes** — optional, up to 500 characters.
- **Camera badge** — loading / live / stale / unavailable.
- **Camera timestamp** — age of the latest detection.
- A link to open Computer Vision Monitoring.

### Section C — Result and submission

Displays:

- Conductor-reported passengers
- Expected onboard passengers
- Camera-detected passengers
- Signed and absolute difference
- Comparison status
- Formula breakdown for each value

Actions:

- **Preview comparison** — validates the form and shows the computed result.
- **Submit checkpoint** — re-reads the latest camera state, then persists the record.
- **Recent checkpoints** — last 5 saved records for the bus. Clicking or pressing Enter/Space on a row loads that saved checkpoint into the form for review or correction.

### Validation rules

- Bus, route, checkpoint, trip ID and conductor ID are required.
- All six count fields are required, non-negative whole numbers, and `<= 500`.
- `starting_onboard + boarded - alighted` must not be negative.
- Ticket issuance requires at least one passenger in an active category, or a non-zero legacy full/half/free count.
- Category labels are required; fare basis must be `full`, `half` or `free`; at least one category stays active.
- Pass registration requires a passenger count of at least one.
- Submission is blocked while another submission is in progress.
- Success is shown only after the backend confirms the database write.

### Camera polling

- Polls `GET /api/conductor/camera-state?bus_id=...` every **2500 ms**.
- Only a fresh `connected` result with a numeric count is treated as live camera data.
- A stale or missing count is displayed as **Unavailable**, never as `0` or a last-known number.
- On submit, the page re-fetches the camera state and sends `camera_estimate` only when the count is fresh.

---

## 4. Counting Convention

The same arithmetic is implemented in `src/conductorPanel.js` and `backend/conductor_db.py`:

```
reported_passengers = active_tickets + valid_passes + other_authorized
expected_onboard    = starting_onboard + boarded - alighted
difference          = reported_passengers - camera_estimate
difference_abs      = abs(difference)
```

When `use_ticketing_totals` is enabled and valid ETM records exist for the trip, the backend replaces the manual `active_tickets` and `valid_passes` values with ETM ticket passengers and valid pass passengers before calculating the reported total. If the ETM lookup fails, the manual values are retained. Checkpoints store both the result and its `ticketing_source`.

Rules:

- `camera_estimate = null` means **no camera data**. It is never converted to zero.
- When no camera estimate exists:
  - `difference = null`
  - `comparison_status = "Comparison unavailable"`
  - `comparison_status_label = "Camera unavailable"`
- When `difference == 0`: status is **Match**.
- Otherwise: status label is **Mismatch: N passenger(s)**.

`expected_onboard` is derived only from passenger movement. `camera_estimate` comes only from YOLO detection. They are deliberately kept separate.

### Camera freshness

- A detection older than **20 seconds** (`CAMERA_COUNT_STALE_SECONDS`) is stale.
- Stale counts are shown as stale/unavailable and are not attached to a new checkpoint.
- If the caller explicitly marks the camera unavailable, the backend skips the camera lookup entirely.

---

## 5. API Reference

Base URL: `http://127.0.0.1:8001`. Vite proxies `/api` to this service.

### Vision

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Backend, model and database health, device, confidence threshold |
| POST | `/api/detect` | Base64 frame → YOLO person detections and count |
| POST | `/api/detect-form` | Multipart image upload variant |
| POST | `/api/reset-tracker` | Clear ByteTrack state |
| POST | `/api/vision/session` | Store camera/model heartbeat for a bus |
| GET | `/api/sample-frame` | Return a benchmark image for testing |

`POST /api/detect` request:

```json
{
  "image": "data:image/jpeg;base64,...",
  "track": true,
  "iou": 0.45,
  "bus_id": "MH-12-QW-4821"
}
```

Response includes `count`, `detections` (box, confidence, label, `track_id`), `image_width`, `image_height`, `inference_time_ms`, `total_processing_ms`, `timestamp`, `model_name`, `device`.

### Conductor

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/conductor/buses` | Registered buses |
| GET | `/api/conductor/routes` | Routes from buses and saved checkpoints |
| GET | `/api/conductor/checkpoint-options` | Known checkpoints, filtered by `route`/`bus_id` |
| GET | `/api/conductor/camera-state` | Shared camera state and latest real count |
| GET | `/api/conductor/latest-detection` | Latest YOLO count for a bus |
| GET | `/api/conductor/comparison` | Legacy quick comparison for a bus + trip |
| GET | `/api/conductor/counts` | Saved conductor ticket/pass counts |
| POST | `/api/conductor/counts` | Save conductor ticket/pass counts |
| POST | `/api/conductor/checkpoint` | Persist a checkpoint submission |
| POST | `/api/conductor/checkpoints` | Alias of the checkpoint POST |
| GET | `/api/conductor/checkpoints` | Checkpoint history (newest first) |
| GET | `/api/conductor/checkpoint/latest` | Latest checkpoint for a bus/trip |
| GET | `/api/conductor/checkpoint/{id}` | Single saved checkpoint |
| POST | `/api/conductor/trips` | Start or return an Active bus trip |
| GET | `/api/conductor/trips` | List trips, filtered by `bus_id`/`status` |
| GET | `/api/conductor/trips/active?bus_id=...` | Latest Active trip for a bus |
| GET | `/api/conductor/trips/{id}` | Trip details with ETM, count and mismatch summary |
| POST | `/api/conductor/trips/{id}/complete` | Complete an Active trip |

### ETM ticketing

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/conductor/fares?route=...` | Route full/half/free fare settings |
| POST | `/api/conductor/fares` | Save route fare settings |
| GET | `/api/conductor/passenger-categories` | Active categories, or all with `include_inactive=true` |
| POST | `/api/conductor/passenger-categories` | Create or update a category |
| GET | `/api/conductor/route-stops?route=...` | Route endpoints plus recorded checkpoints |
| GET | `/api/conductor/tickets` | Ticket history filtered by bus/trip/status |
| GET | `/api/conductor/tickets/{id}` | Ticket details with passenger category line items |
| POST | `/api/conductor/tickets` | Issue a ticket transaction |
| POST | `/api/conductor/tickets/{id}/cancel` | Cancel a ticket |
| GET | `/api/conductor/passes` | Pass registrations filtered by bus/trip/status |
| POST | `/api/conductor/passes` | Register a passenger pass |
| POST | `/api/conductor/passes/{id}/cancel` | Cancel a pass |
| GET | `/api/conductor/ticketing/summary` | Valid ticket/pass totals for a bus trip |

### Alerts, analytics, dispatch and inspections

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/alerts` | List mismatch alerts with optional filters |
| GET | `/api/alerts/{id}` | Alert details with dispatch |
| POST/PUT | `/api/alerts/{id}/status` | Set `New`, `Under Review` or `Resolved` |
| POST/PUT | `/api/alerts/{id}/review` | Mark `Under Review` |
| POST/PUT | `/api/alerts/{id}/resolve` | Mark `Resolved` |
| GET | `/api/analytics/passengers?days=7&route=...` | ETM, checkpoint, alert and inspection analytics |
| GET | `/api/checkers` | Checker roster and availability |
| GET | `/api/checker-dispatches` | Dispatch list with alert context |
| POST | `/api/checker-dispatches` | Create a manual assignment |
| POST | `/api/checker-dispatches/{id}/complete` | Record outcome and release checker |
| GET | `/api/inspections` | Inspection history derived from dispatches |

Alias prefix `/api/mismatch-alerts` is also supported.

The control-room pages load these endpoints directly. Alert review/resolve, checker assignment, dispatch completion and inspection history all update the same backend records used by the conductor workflow.

---

## 6. Database Schema

Database: `backend/data/conductor.db` (created on backend startup).

| Table | Purpose |
| --- | --- |
| `registered_buses` | Fleet bus records (seeded on first run) |
| `bus_trips` | Active/completed trip lifecycle rows linked to bus and route |
| `latest_detections` | One latest YOLO count per bus, linked to the active trip when available |
| `camera_sessions` | Latest camera/model heartbeat per bus |
| `checkpoint_submissions` | Append-only checkpoint audit trail with ETM snapshot totals |
| `expected_passenger_counts` | Expected/reported occupancy audit rows per checkpoint and trip |
| `computer_vision_counts` | Camera count audit rows per checkpoint and trip |
| `conductor_records` | Latest ticket/pass totals per bus + trip |
| `fare_settings` | Per-route full/half/free fares and currency |
| `passenger_categories` | Operator-configurable category lookup with label, fare basis, order and active flag |
| `tickets` | Ticket transactions with fare, route, boarding/destination stops, trip link and status |
| `ticket_passenger_categories` | Per-ticket category snapshots (code, label, fare basis), counts, unit fares and line totals |
| `pass_registrations` | Passenger pass records with validity dates, trip link and status |
| `mismatch_alerts` | Alerts generated from checkpoint differences, linked to trip/count rows |
| `checkers` | Checker roster |
| `checker_dispatches` | Assignments linked to alerts, with trip link, outcome and completion fields |

`checkpoint_submissions` stores both the raw inputs and derived values (`reported_passengers`, `expected_onboard`, `difference`, `difference_abs`, `comparison_status`, `camera_status`, `period_start`, `period_end`, `alert_id`, `source`). ETM snapshots add `ticket_count`, `ticket_passengers`, `pass_count`, `pass_passengers`, `ticket_revenue` and `ticketing_source`.

Each checkpoint is inserted as a new row; previous submissions are never overwritten. A checkpoint writes one `expected_passenger_counts` row and, when a camera estimate exists, one `computer_vision_counts` row. Alerts and dispatches copy the resulting `bus_trip_id`, `expected_count_id` and `vision_count_id` where available. Cancelled tickets and passes remain as history but are excluded from valid totals.

Legacy rows written before the trip tables existed keep `bus_trip_id = NULL`; no destructive backfill is performed. New writes are always linked to a trip.

---

## 7. Mismatch and Dispatch Flow

```
Conductor submits checkpoint
        ↓
POST /api/conductor/checkpoint
        ↓
checkpoint_submissions row committed
        ↓
alert_dispatch.process_checkpoint_record()
        ↓
abs(difference) >= MISMATCH_THRESHOLD ?
        ↓ yes
mismatch_alerts row (unique checkpoint_submission_id)
        ↓
available checker selected → checker_dispatches row
        ↓
checker availability set to "On inspection"
        ↓
operator may assign manually from Mismatch Alerts / Checker Dispatch
        ↓
POST /api/checker-dispatches/{id}/complete
        ↓
dispatch outcome stored → linked alert resolved → checker available again
        ↓
Inspection History and Passenger Analytics reflect the result
```

- Thresholds are backend-only.
- Default mismatch threshold: **2** passengers.
- Default high-severity threshold: **4** passengers.
- Severity: `High` at/above high threshold, `Medium` at/above mismatch threshold, otherwise `Low`.
- No camera estimate → no alert from the automatic checkpoint flow.
- Alert and automatic dispatch creation are idempotent: the same checkpoint cannot create a second alert or second automatic dispatch.
- A manual dispatch can be linked to an alert; an alert cannot have more than one dispatch.
- Completion outcomes are `Mismatch Confirmed`, `No Mismatch Found` or `Inconclusive`.
- A camera count is an estimate; an alert requests human verification and is not a finding of fare evasion.

---

## 8. Configuration

Environment variables (`.env`):

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Backend bind host |
| `PORT` | `8001` | Backend port |
| `YOLO_MODEL_PATH` | `yolov8n.pt` | YOLO weights path |
| `YOLO_CONFIDENCE_THRESHOLD` | `0.25` | Person detection confidence, valid range `0.01–0.99` |
| `MISMATCH_THRESHOLD` | `2` | Minimum absolute variance that raises an alert |
| `HIGH_MISMATCH_THRESHOLD` | `4` | Variance that raises a high-severity alert |

The frontend does not configure thresholds; they are read by the backend on each request.

---

## 9. Running Locally

From the repository root:

```powershell
# Terminal 1 - backend (use the project virtual environment)
backend\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8001 --reload

# Terminal 2 - frontend
npm run dev
```

Or use the provided scripts:

- `start_backend.bat`
- `start_frontend.bat`
- `start_system.bat` (launches both)

Open `http://localhost:5173`, then:

1. Go to **Computer Vision Monitoring**.
2. Select the bus.
3. Click **Allow Camera & Start Monitoring** and grant permission.
4. Go to **Conductor Panel**; the camera session continues and the live count is shared.
5. Configure fares, issue tickets or register passes, then enter trip details and counts, preview, and submit.
6. Open **Mismatch Alerts**, **Passenger Analytics**, **Checker Dispatch** or **Inspection History** to work with the persisted backend records.

Prerequisites:

- Python dependencies from `backend/requirements.txt` (FastAPI, Uvicorn, Ultralytics, OpenCV, NumPy, PyTorch), preferably in `backend/.venv`.
- `yolov8n.pt` at the repository root or backend directory.
- Node dependencies via `npm install`.
- A browser on `localhost` or HTTPS (required for camera access).
- Node `vite` 6, React 19 and Python 3.12 are the tested versions.

---

## 10. Troubleshooting

| Symptom | Likely cause / action |
| --- | --- |
| Camera status "Permission Denied" | Allow camera in the browser address bar, then Restart Camera |
| Camera status "Camera Unavailable" | No webcam, device in use by another app, or non-secure context |
| "Cannot reach the detection backend" | Backend not running on port 8001 |
| Model status "Model Error" | `yolov8n.pt` missing or Ultralytics/Torch not installed |
| Conductor camera shows "Unavailable" | No fresh frames for the selected bus; open Monitoring and start the camera |
| Conductor camera shows "Camera data stale" | Last detection is older than 20 seconds; resume live camera |
| "Checkpoint was not saved" | Validation error or backend/database failure; read the message |
| Alerts/analytics show empty | Backend not running, wrong proxy port, or no ETM/checkpoint records yet |
| "No checkers are currently available" | Complete an active inspection or add an available checker to the roster |
| A ticket/pass cannot be cancelled twice | Only `Valid` records can transition to `Cancelled` |
| Count is `0` while people are visible | Confidence threshold too high or poor lighting/angle |
| Count changes between frames | Expected: the count is current-frame only, not cumulative |

---

## 11. Code Map

| File | Responsibility |
| --- | --- |
| `src/visionCamera.js` | Shared camera stream, inference loop, heartbeat, active bus, device list |
| `src/computerVision.js` | Monitoring page markup, status UI, canvas bounding boxes |
| `src/conductorPanel.js` | Conductor page markup, ETM forms, validation, camera polling, submission |
| `app.js` | Page router, alert/analytics/dispatch/inspection API wiring, exports |
| `src/main.jsx` | React shell, navigation, dynamic alert badge, version footer |
| `backend/main.py` | FastAPI endpoints, YOLO inference, request validation |
| `backend/conductor_db.py` | SQLite schema and checkpoint/camera/bus/ETM snapshot persistence |
| `backend/etm_db.py` | Fares, tickets, passes, ticketing summaries and analytics |
| `backend/alert_dispatch.py` | Alert thresholds, alerts, checker dispatch, completion and inspection history |
| `vite.config.js` | Frontend dev server and `/api` proxy to port 8001 |
| `backend/data/conductor.db` | Runtime SQLite database |
| `test_conductor_panel_api.py` | Isolated conductor/checkpoint API regression tests |
| `test_etm_workflow.py` | Isolated ETM, analytics, dispatch and inspection tests |
| `test_booking_models.py` | Isolated trip lifecycle, passenger category, count-link and dispatch fallback tests |

---

## 12. Design Limitations

- The camera estimate counts people **visible in the latest frame**; it is not a turnstile or cumulative boarding counter.
- People outside the frame, occluded, or below the confidence threshold are not counted.
- A single browser camera instance drives both pages; multiple devices do not share a camera stream.
- Checkpoint, ticket and pass history is append-only; tickets/passes can be cancelled but not edited or deleted.
- Automatic checker dispatch selects the first available checker by ID.
- ETM totals are scoped to one `bus_trip_id`; there is no multi-trip consolidation yet.
- Trip, expected-count, vision-count and passenger-category history is append-only. Legacy transactions before this schema retain `NULL` trip links.
- Passenger analytics aggregates ETM data for the selected day window and route; the trend chart always shows the latest seven days.
- Overview, Live Bus Monitoring and Bus & Route Management still display labelled sample data and do not read live GPS.
- `GET /api/conductor/comparison` is a legacy endpoint and uses the opposite difference sign (`detected - reported`) from the checkpoint workflow (`reported - camera`). The Conductor Panel uses the checkpoint convention.
- `test_conductor_system.py` and `test_conductor_db_standalone.py` mutate the live database and should only be run with `conductor_db.DB_PATH` isolated to a temporary file.
