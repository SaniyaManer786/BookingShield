"""
SMART ST Control Center - Conductor Panel Persistence Module
SQLite-backed storage for conductor passenger accounting and real-time detection syncing.
"""

import os
import re
import sqlite3
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any

DB_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DB_DIR, "conductor.db")

# Fleet seed data matching the SMART ST demonstration fleet
INITIAL_BUSES = [
    {
        "id": "MH-12-QW-4821",
        "fleet": "ST-1042",
        "route": "Pune – Mumbai",
        "depot": "Swargate",
        "capacity": 52,
        "operator": "A. Jadhav",
        "default_trip": "TRIP-1042-01",
        "status": "Active"
    },
    {
        "id": "MH-14-BT-1906",
        "fleet": "ST-0871",
        "route": "Pune – Nashik",
        "depot": "Shivajinagar",
        "capacity": 52,
        "operator": "S. Pawar",
        "default_trip": "TRIP-0871-02",
        "status": "Active"
    },
    {
        "id": "MH-09-CV-3372",
        "fleet": "ST-1208",
        "route": "Pune – Kolhapur",
        "depot": "Swargate",
        "capacity": 52,
        "operator": "R. Shinde",
        "default_trip": "TRIP-1208-01",
        "status": "Active"
    },
    {
        "id": "MH-12-LM-6510",
        "fleet": "ST-0644",
        "route": "Pune – Satara",
        "depot": "Katraj",
        "capacity": 52,
        "operator": "P. More",
        "default_trip": "TRIP-0644-03",
        "status": "Active"
    },
    {
        "id": "MH-11-AX-2208",
        "fleet": "ST-0955",
        "route": "Pune – Solapur",
        "depot": "Hadapsar",
        "capacity": 52,
        "operator": "N. Bhosale",
        "default_trip": "TRIP-0955-01",
        "status": "Active"
    },
    {
        "id": "MH-01-CD-7834",
        "fleet": "ST-1320",
        "route": "Mumbai – Nashik",
        "depot": "Mumbai Central",
        "capacity": 52,
        "operator": "M. Chavan",
        "default_trip": "TRIP-1320-04",
        "status": "Active"
    },
    {
        "id": "MH-12-JK-9083",
        "fleet": "ST-0712",
        "route": "Pune – Mumbai",
        "depot": "Swargate",
        "capacity": 52,
        "operator": "V. Koli",
        "default_trip": "TRIP-0712-02",
        "status": "Active"
    },
    {
        "id": "MH-15-GH-4417",
        "fleet": "ST-1106",
        "route": "Pune – Nashik",
        "depot": "Nashik Road",
        "capacity": 52,
        "operator": "D. Pawar",
        "default_trip": "TRIP-1106-01",
        "status": "Active"
    }
]


# Maximum passengers accepted in a single counting field (safety limit)
MAX_PASSENGER_COUNT = 500

# A camera count older than this many seconds is reported as stale, not current.
CAMERA_COUNT_STALE_SECONDS = 20

TRIP_STATUSES = {"Active", "Completed", "Cancelled"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_identifier(value: Any, field: str, max_length: int = 50) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} is required.")
    if len(text) > max_length:
        raise ValueError(f"{field} must be at most {max_length} characters.")
    return text


def _route_key(value: Any) -> str:
    """Normalises route names for comparison while preserving stored values."""
    text = str(value or "").strip().casefold()
    for dash in ("\u2013", "\u2014", "\u2212"):
        text = text.replace(dash, "-")
    return " ".join(text.split()).replace(" - ", "-")


def get_db_connection() -> sqlite3.Connection:
    """Returns an SQLite connection with Row row_factory."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_columns(cursor: sqlite3.Cursor, table: str, columns: List[tuple]) -> None:
    """Adds missing columns to an existing table (safe migration for live databases)."""
    cursor.execute(f"PRAGMA table_info({table})")
    existing = [row[1] for row in cursor.fetchall()]
    for name, ddl in columns:
        if name not in existing:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def compute_checkpoint_metrics(
    active_tickets: int,
    valid_passes: int,
    other_authorized: int,
    starting_onboard: int,
    boarded: int,
    alighted: int,
    camera_estimate: Optional[int],
) -> Dict[str, Any]:
    """
    Single source of truth for checkpoint passenger arithmetic.

    Business rules (identical on the frontend, see src/conductorPanel.js):
      reported_passengers = active_tickets + valid_passes + other_authorized
      expected_onboard    = starting_onboard + boarded - alighted
      difference          = reported_passengers - camera_estimate  (signed)
      difference_abs      = abs(difference)

    The two occupancy values are deliberately kept separate:
      expected_onboard is derived only from passenger movement;
      camera_estimate is only ever a real YOLO/OpenCV detection count.

    A camera estimate of None means "no camera data" and never becomes zero.
    comparison_status keeps its historical wording for stored records, while
    comparison_status_label carries the panel-facing wording required by the
    Conductor Panel ("Match" / "Mismatch: N passengers" / unavailable).
    """
    reported_passengers = active_tickets + valid_passes + other_authorized
    expected_onboard = starting_onboard + boarded - alighted

    if camera_estimate is None:
        difference = None
        difference_abs = None
        reported_difference = None
        comparison_status = "Comparison unavailable"
        comparison_status_label = "Camera unavailable"
    else:
        difference = reported_passengers - camera_estimate
        difference_abs = abs(difference)
        # Kept for backwards compatibility with earlier records / API clients.
        reported_difference = difference
        if difference == 0:
            comparison_status = "Match"
            comparison_status_label = "Match"
        else:
            comparison_status = "Discrepancy — verify"
            comparison_status_label = f"Mismatch: {difference_abs} passenger{'s' if difference_abs != 1 else ''}"

    return {
        "reported_passengers": reported_passengers,
        "expected_onboard": expected_onboard,
        "camera_estimate": camera_estimate,
        "difference": difference,
        "difference_abs": difference_abs,
        "reported_difference": reported_difference,
        "comparison_status": comparison_status,
        "comparison_status_label": comparison_status_label,
    }


def init_db():
    """Initializes database schema and populates initial registered buses."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()

        # Conductor records table (unique per bus_id + trip_id)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS conductor_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bus_id TEXT NOT NULL,
                trip_id TEXT NOT NULL,
                active_tickets INTEGER NOT NULL,
                valid_passes INTEGER NOT NULL,
                total_reported INTEGER NOT NULL,
                notes TEXT DEFAULT '',
                conductor_name TEXT DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(bus_id, trip_id)
            )
        """)

        # Latest camera detections table (one latest row per bus_id)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS latest_detections (
                bus_id TEXT PRIMARY KEY,
                detected_count INTEGER NOT NULL,
                inference_time_ms REAL DEFAULT 0.0,
                updated_at TEXT NOT NULL
            )
        """)

        # Camera session heartbeat table (status reported by the monitoring page)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS camera_sessions (
                bus_id TEXT PRIMARY KEY,
                session_id TEXT DEFAULT '',
                camera_status TEXT DEFAULT 'idle',
                model_status TEXT DEFAULT 'unknown',
                message TEXT DEFAULT '',
                updated_at TEXT NOT NULL
            )
        """)

        # Registered buses table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS registered_buses (
                id TEXT PRIMARY KEY,
                fleet TEXT NOT NULL,
                route TEXT NOT NULL,
                depot TEXT NOT NULL,
                capacity INTEGER NOT NULL,
                operator TEXT NOT NULL,
                default_trip TEXT NOT NULL,
                status TEXT NOT NULL
            )
        """)

        # Bus trip lifecycle. One bus may only have one Active trip at a time.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS bus_trips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trip_id TEXT NOT NULL,
                bus_id TEXT NOT NULL,
                route TEXT NOT NULL,
                conductor_id TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Active',
                started_at TEXT NOT NULL,
                ended_at TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        cursor.execute("DROP INDEX IF EXISTS idx_bus_trip_active")
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_bus_trips_one_active
            ON bus_trips(bus_id) WHERE status = 'Active'
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_bus_trips_bus_trip
            ON bus_trips(bus_id, trip_id, started_at DESC)
        """)

        # Append-only expected passenger count for each checkpoint calculation.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS expected_passenger_counts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bus_trip_id INTEGER NOT NULL,
                checkpoint_submission_id INTEGER UNIQUE,
                bus_id TEXT NOT NULL,
                route TEXT NOT NULL,
                trip_id TEXT NOT NULL,
                checkpoint TEXT DEFAULT '',
                starting_onboard INTEGER NOT NULL DEFAULT 0,
                boarded INTEGER NOT NULL DEFAULT 0,
                alighted INTEGER NOT NULL DEFAULT 0,
                expected_count INTEGER NOT NULL,
                reported_count INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_expected_counts_bus_trip
            ON expected_passenger_counts(bus_trip_id, created_at DESC)
        """)

        # Computer-vision snapshot attached to a checkpoint. Live detection
        # state remains in latest_detections; this table is the trip audit trail.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS computer_vision_counts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bus_trip_id INTEGER NOT NULL,
                checkpoint_submission_id INTEGER,
                bus_id TEXT NOT NULL,
                route TEXT NOT NULL,
                trip_id TEXT NOT NULL,
                checkpoint TEXT DEFAULT '',
                detected_count INTEGER NOT NULL,
                inference_time_ms REAL NOT NULL DEFAULT 0.0,
                camera_status TEXT DEFAULT '',
                captured_at TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_vision_counts_bus_trip
            ON computer_vision_counts(bus_trip_id, created_at DESC)
        """)

        ensure_columns(cursor, "conductor_records", [
            ("bus_trip_id", "INTEGER"),
        ])
        ensure_columns(cursor, "latest_detections", [
            ("bus_trip_id", "INTEGER"),
            ("trip_id", "TEXT DEFAULT ''"),
            ("route", "TEXT DEFAULT ''"),
        ])

        # Checkpoint submissions table (persistent checkpoint-by-checkpoint audit trail)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS checkpoint_submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bus_id TEXT NOT NULL,
                route TEXT NOT NULL,
                trip_id TEXT NOT NULL,
                checkpoint TEXT NOT NULL,
                conductor_id TEXT DEFAULT '',
                active_tickets INTEGER NOT NULL,
                valid_passes INTEGER NOT NULL,
                other_authorized INTEGER NOT NULL DEFAULT 0,
                starting_onboard INTEGER NOT NULL,
                boarded INTEGER NOT NULL DEFAULT 0,
                alighted INTEGER NOT NULL DEFAULT 0,
                reported_passengers INTEGER NOT NULL,
                expected_onboard INTEGER NOT NULL,
                camera_estimate INTEGER,
                camera_detection_time TEXT DEFAULT '',
                difference INTEGER,
                comparison_status TEXT NOT NULL,
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chk_bus_trip ON checkpoint_submissions(bus_id, trip_id, created_at DESC)")

        # Safe migration for existing DB instances: add newer columns if missing
        cursor.execute("PRAGMA table_info(checkpoint_submissions)")
        existing_cols = [r[1] for r in cursor.fetchall()]
        if "camera_detection_time" not in existing_cols:
            cursor.execute("ALTER TABLE checkpoint_submissions ADD COLUMN camera_detection_time TEXT DEFAULT ''")

        ensure_columns(cursor, "checkpoint_submissions", [
            ("bus_trip_id", "INTEGER"),
            ("period_start", "TEXT DEFAULT ''"),
            ("period_end", "TEXT DEFAULT ''"),
            ("camera_status", "TEXT DEFAULT ''"),
            ("reported_difference", "INTEGER"),
            ("difference_abs", "INTEGER"),
            ("alert_id", "INTEGER"),
            ("source", "TEXT DEFAULT 'conductor_panel'"),
            ("ticket_count", "INTEGER DEFAULT 0"),
            ("ticket_passengers", "INTEGER DEFAULT 0"),
            ("pass_count", "INTEGER DEFAULT 0"),
            ("pass_passengers", "INTEGER DEFAULT 0"),
            ("ticket_revenue", "REAL DEFAULT 0.0"),
            ("ticketing_source", "TEXT DEFAULT 'manual'"),
        ])

        # Populate registered buses if empty
        cursor.execute("SELECT COUNT(*) FROM registered_buses")
        if cursor.fetchone()[0] == 0:
            for b in INITIAL_BUSES:
                cursor.execute("""
                    INSERT INTO registered_buses 
                    (id, fleet, route, depot, capacity, operator, default_trip, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    b["id"], b["fleet"], b["route"], b["depot"],
                    b["capacity"], b["operator"], b["default_trip"], b["status"]
                ))

        conn.commit()
    finally:
        conn.close()


def _registered_bus(cursor: sqlite3.Cursor, bus_id: str) -> Dict[str, Any]:
    cursor.execute("SELECT * FROM registered_buses WHERE id = ?", (bus_id,))
    row = cursor.fetchone()
    if not row:
        raise ValueError(f"Unknown bus registration number: {bus_id}.")
    return dict(row)


def _validate_trip_details(
    cursor: sqlite3.Cursor,
    bus_id: str,
    route: str,
    trip_id: str,
    conductor_id: str = "",
) -> tuple:
    bus_id = _clean_identifier(bus_id, "Bus registration number")
    route = _clean_identifier(route, "Route", max_length=100)
    trip_id = _clean_identifier(trip_id, "Trip identifier")
    conductor_id = str(conductor_id or "").strip()
    if len(conductor_id) > 100:
        raise ValueError("Conductor must be at most 100 characters.")
    bus = _registered_bus(cursor, bus_id)
    if _route_key(route) != _route_key(bus["route"]):
        raise ValueError(
            f"Route '{route}' does not match the registered route for bus {bus_id}."
        )
    return bus_id, route, trip_id, conductor_id


def start_bus_trip(
    bus_id: str,
    route: str,
    trip_id: str,
    conductor_id: str = "",
) -> Dict[str, Any]:
    """
    Starts an Active trip for a registered bus.

    Idempotent for the same bus/trip. A bus cannot have two Active trips, and
    the route must match the bus registration.
    """
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        bus_id, route, trip_id, conductor_id = _validate_trip_details(
            cursor, bus_id, route, trip_id, conductor_id
        )
        cursor.execute(
            "SELECT * FROM bus_trips WHERE bus_id = ? AND status = 'Active' ORDER BY id DESC LIMIT 1",
            (bus_id,),
        )
        active = cursor.fetchone()
        if active:
            if active["trip_id"] != trip_id:
                raise ValueError(
                    f"Bus {bus_id} already has an active trip ({active['trip_id']}). "
                    "Complete it before starting another trip."
                )
            if _route_key(active["route"]) != _route_key(route):
                raise ValueError(
                    f"Active trip {trip_id} belongs to route '{active['route']}', not '{route}'."
                )
            if conductor_id and not active["conductor_id"]:
                cursor.execute(
                    "UPDATE bus_trips SET conductor_id = ?, updated_at = ? WHERE id = ?",
                    (conductor_id, _now_iso(), active["id"]),
                )
                conn.commit()
                cursor.execute("SELECT * FROM bus_trips WHERE id = ?", (active["id"],))
                return dict(cursor.fetchone())
            return dict(active)

        now_iso = _now_iso()
        try:
            cursor.execute("""
                INSERT INTO bus_trips
                (trip_id, bus_id, route, conductor_id, status, started_at, ended_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'Active', ?, '', ?, ?)
            """, (trip_id, bus_id, route, conductor_id, now_iso, now_iso, now_iso))
            trip_record_id = cursor.lastrowid
            conn.commit()
        except sqlite3.IntegrityError:
            conn.rollback()
            cursor.execute(
                "SELECT * FROM bus_trips WHERE bus_id = ? AND status = 'Active' ORDER BY id DESC LIMIT 1",
                (bus_id,),
            )
            active = cursor.fetchone()
            if active and active["trip_id"] == trip_id:
                return dict(active)
            raise ValueError(f"Bus {bus_id} already has an active trip.") from None
    finally:
        conn.close()
    return get_bus_trip_by_id(trip_record_id) or {}


def ensure_active_bus_trip(
    bus_id: str,
    route: str,
    trip_id: str,
    conductor_id: str = "",
) -> Dict[str, Any]:
    """Returns the matching Active trip, starting one when the bus has none."""
    bus_id = _clean_identifier(bus_id, "Bus registration number")
    trip_id = _clean_identifier(trip_id, "Trip identifier")
    active = get_active_bus_trip(bus_id)
    if active:
        if active["trip_id"] != trip_id:
            raise ValueError(
                f"Bus {bus_id} is active on trip {active['trip_id']}, not {trip_id}."
            )
        if _route_key(active["route"]) != _route_key(route):
            raise ValueError(
                f"Active trip {trip_id} belongs to route '{active['route']}', not '{route}'."
            )
        return active
    return start_bus_trip(bus_id, route, trip_id, conductor_id)


def get_bus_trip_by_id(trip_record_id: int) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM bus_trips WHERE id = ?", (trip_record_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_active_bus_trip(bus_id: str) -> Optional[Dict[str, Any]]:
    bus_id = str(bus_id or "").strip()
    if not bus_id:
        return None
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM bus_trips WHERE bus_id = ? AND status = 'Active' ORDER BY id DESC LIMIT 1",
            (bus_id,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_bus_trips(
    bus_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM bus_trips"
        conditions: List[str] = []
        params: List[Any] = []
        if bus_id and bus_id.strip():
            conditions.append("bus_id = ?")
            params.append(bus_id.strip())
        if status and status.strip():
            status = status.strip().title()
            if status not in TRIP_STATUSES:
                raise ValueError(f"Status must be one of: {', '.join(sorted(TRIP_STATUSES))}.")
            conditions.append("status = ?")
            params.append(status)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, started_at DESC, id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        cursor.execute(query, tuple(params))
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def complete_bus_trip(
    trip_record_id: Optional[int] = None,
    bus_id: Optional[str] = None,
    trip_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Marks a trip Completed. Repeating completion is idempotent."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        if trip_record_id is not None:
            cursor.execute("SELECT * FROM bus_trips WHERE id = ?", (trip_record_id,))
            trip = cursor.fetchone()
        else:
            bus_id = str(bus_id or "").strip()
            trip_id = str(trip_id or "").strip()
            if not bus_id or not trip_id:
                raise ValueError("trip record id or bus_id and trip_id are required.")
            cursor.execute("""
                SELECT * FROM bus_trips
                WHERE bus_id = ? AND trip_id = ?
                ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, id DESC LIMIT 1
            """, (bus_id, trip_id))
            trip = cursor.fetchone()
        if not trip:
            raise ValueError("Trip not found.")
        if trip["status"] == "Completed":
            return dict(trip)
        if trip["status"] == "Cancelled":
            raise ValueError("Cancelled trips cannot be completed.")
        now_iso = _now_iso()
        cursor.execute(
            "UPDATE bus_trips SET status = 'Completed', ended_at = ?, updated_at = ? WHERE id = ?",
            (now_iso, now_iso, trip["id"]),
        )
        conn.commit()
        cursor.execute("SELECT * FROM bus_trips WHERE id = ?", (trip["id"],))
        return dict(cursor.fetchone())
    finally:
        conn.close()


def get_trip_summary(trip_record_id: int) -> Dict[str, Any]:
    """Returns persisted ETM, occupancy, camera and mismatch totals for a trip."""
    trip = get_bus_trip_by_id(trip_record_id)
    if not trip:
        raise ValueError("Trip not found.")

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        summary: Dict[str, Any] = {
            "trip": trip,
            "ticket_count": 0,
            "ticket_passengers": 0,
            "pass_count": 0,
            "pass_passengers": 0,
            "checkpoint_count": 0,
            "expected_count": 0,
            "vision_count": 0,
            "mismatch_count": 0,
            "latest_expected_count": None,
            "latest_reported_count": None,
            "latest_vision_count": None,
            "latest_difference": None,
            "passenger_categories": [],
        }
        try:
            cursor.execute("""
                SELECT COUNT(*) AS ticket_count, COALESCE(SUM(total_passengers), 0) AS passengers
                FROM tickets WHERE bus_trip_id = ? AND status = 'Valid'
            """, (trip_record_id,))
            row = cursor.fetchone()
            summary["ticket_count"] = int(row["ticket_count"] or 0)
            summary["ticket_passengers"] = int(row["passengers"] or 0)
        except sqlite3.OperationalError:
            pass
        try:
            cursor.execute("""
                SELECT COUNT(*) AS pass_count, COALESCE(SUM(passenger_count), 0) AS passengers
                FROM pass_registrations
                WHERE bus_trip_id = ? AND status = 'Valid'
                  AND (valid_from = '' OR date(valid_from) <= date('now'))
                  AND (valid_until = '' OR date(valid_until) >= date('now'))
            """, (trip_record_id,))
            row = cursor.fetchone()
            summary["pass_count"] = int(row["pass_count"] or 0)
            summary["pass_passengers"] = int(row["passengers"] or 0)
        except sqlite3.OperationalError:
            pass
        cursor.execute(
            "SELECT COUNT(*) FROM checkpoint_submissions WHERE bus_trip_id = ?",
            (trip_record_id,),
        )
        summary["checkpoint_count"] = int(cursor.fetchone()[0] or 0)
        cursor.execute(
            "SELECT COUNT(*) FROM expected_passenger_counts WHERE bus_trip_id = ?",
            (trip_record_id,),
        )
        summary["expected_count"] = int(cursor.fetchone()[0] or 0)
        cursor.execute(
            "SELECT COUNT(*) FROM computer_vision_counts WHERE bus_trip_id = ?",
            (trip_record_id,),
        )
        summary["vision_count"] = int(cursor.fetchone()[0] or 0)
        try:
            cursor.execute(
                "SELECT COUNT(*) FROM mismatch_alerts WHERE bus_trip_id = ?",
                (trip_record_id,),
            )
            summary["mismatch_count"] = int(cursor.fetchone()[0] or 0)
        except sqlite3.OperationalError:
            pass
        cursor.execute("""
            SELECT expected_count, reported_count
            FROM expected_passenger_counts
            WHERE bus_trip_id = ? ORDER BY id DESC LIMIT 1
        """, (trip_record_id,))
        row = cursor.fetchone()
        if row:
            summary["latest_expected_count"] = int(row["expected_count"])
            summary["latest_reported_count"] = int(row["reported_count"])
        cursor.execute("""
            SELECT detected_count FROM computer_vision_counts
            WHERE bus_trip_id = ? ORDER BY id DESC LIMIT 1
        """, (trip_record_id,))
        row = cursor.fetchone()
        if row:
            summary["latest_vision_count"] = int(row["detected_count"])
            if summary["latest_reported_count"] is not None:
                summary["latest_difference"] = (
                    summary["latest_reported_count"] - summary["latest_vision_count"]
                )
        try:
            cursor.execute("""
                SELECT category_code, SUM(passenger_count) AS passengers,
                       SUM(line_total) AS revenue
                FROM ticket_passenger_categories
                WHERE ticket_id IN (SELECT id FROM tickets WHERE bus_trip_id = ?)
                GROUP BY category_code ORDER BY category_code
            """, (trip_record_id,))
            summary["passenger_categories"] = [dict(row) for row in cursor.fetchall()]
        except sqlite3.OperationalError:
            pass
        return summary
    finally:
        conn.close()


def get_registered_buses() -> List[Dict[str, Any]]:
    """Returns all registered buses."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM registered_buses ORDER BY id ASC")
        rows = cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def save_conductor_counts(
    bus_id: str,
    trip_id: str,
    active_tickets: int,
    valid_passes: int,
    notes: str = "",
    conductor_name: str = ""
) -> Dict[str, Any]:
    """
    Saves or updates conductor counts for a specific bus and trip.
    Calculates total_reported = active_tickets + valid_passes.
    """
    if active_tickets < 0 or valid_passes < 0:
        raise ValueError("Ticket and pass counts must be non-negative integers.")

    bus_id = bus_id.strip()
    trip_id = trip_id.strip()
    if not bus_id or not trip_id:
        raise ValueError("Both bus_id and trip_id are required.")

    total_reported = active_tickets + valid_passes
    now_iso = datetime.now(timezone.utc).isoformat()

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM bus_trips WHERE bus_id = ? AND trip_id = ? AND status = 'Active' ORDER BY id DESC LIMIT 1",
            (bus_id, trip_id),
        )
        trip_row = cursor.fetchone()
        bus_trip_id = trip_row["id"] if trip_row else None
        cursor.execute("""
            INSERT INTO conductor_records
            (bus_id, trip_id, active_tickets, valid_passes, total_reported, notes, conductor_name, bus_trip_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bus_id, trip_id) DO UPDATE SET
                active_tickets = excluded.active_tickets,
                valid_passes = excluded.valid_passes,
                total_reported = excluded.total_reported,
                notes = excluded.notes,
                conductor_name = excluded.conductor_name,
                bus_trip_id = COALESCE(excluded.bus_trip_id, conductor_records.bus_trip_id),
                updated_at = excluded.updated_at
        """, (bus_id, trip_id, active_tickets, valid_passes, total_reported, notes.strip(), conductor_name.strip(), bus_trip_id, now_iso))
        conn.commit()

        return {
            "bus_id": bus_id,
            "trip_id": trip_id,
            "active_tickets": active_tickets,
            "valid_passes": valid_passes,
            "total_reported": total_reported,
            "notes": notes.strip(),
            "conductor_name": conductor_name.strip(),
            "bus_trip_id": bus_trip_id,
            "updated_at": now_iso
        }
    finally:
        conn.close()


def get_conductor_counts(bus_id: str, trip_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves saved conductor counts for a given bus_id and trip_id."""
    bus_id = bus_id.strip()
    trip_id = trip_id.strip()
    if not bus_id or not trip_id:
        return None

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM conductor_records 
            WHERE bus_id = ? AND trip_id = ?
        """, (bus_id, trip_id))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def record_latest_detection(bus_id: str, count: int, inference_time_ms: float = 0.0) -> Dict[str, Any]:
    """Records the latest real YOLO camera detection count for a bus."""
    bus_id = bus_id.strip() if bus_id else "MH-12-QW-4821"
    now_iso = datetime.now(timezone.utc).isoformat()

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM bus_trips WHERE bus_id = ? AND status = 'Active' ORDER BY id DESC LIMIT 1",
            (bus_id,),
        )
        trip = cursor.fetchone()
        cursor.execute("""
            INSERT INTO latest_detections
            (bus_id, detected_count, inference_time_ms, bus_trip_id, trip_id, route, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bus_id) DO UPDATE SET
                detected_count = excluded.detected_count,
                inference_time_ms = excluded.inference_time_ms,
                bus_trip_id = excluded.bus_trip_id,
                trip_id = excluded.trip_id,
                route = excluded.route,
                updated_at = excluded.updated_at
        """, (
            bus_id, count, inference_time_ms,
            trip["id"] if trip else None,
            trip["trip_id"] if trip else "",
            trip["route"] if trip else "",
            now_iso,
        ))
        conn.commit()

        return {
            "bus_id": bus_id,
            "detected_count": count,
            "inference_time_ms": inference_time_ms,
            "bus_trip_id": trip["id"] if trip else None,
            "trip_id": trip["trip_id"] if trip else "",
            "route": trip["route"] if trip else "",
            "updated_at": now_iso
        }
    finally:
        conn.close()


def get_latest_detection(bus_id: str) -> Optional[Dict[str, Any]]:
    """Gets the latest real YOLO camera detection count for a bus."""
    bus_id = bus_id.strip() if bus_id else "MH-12-QW-4821"

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM latest_detections WHERE bus_id = ?", (bus_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_comparison(bus_id: str, trip_id: str) -> Dict[str, Any]:
    """
    Computes full passenger verification comparison:
    - Detected people count (from YOLO/OpenCV)
    - Conductor active tickets
    - Conductor valid passes
    - Total conductor reported passengers (active_tickets + valid_passes)
    - Difference (detected_count - total_reported)
    - Status & discrepancy indication
    """
    conductor_data = get_conductor_counts(bus_id, trip_id)
    detection_data = get_latest_detection(bus_id)

    has_conductor_record = conductor_data is not None
    has_detection_record = detection_data is not None

    active_tickets = conductor_data["active_tickets"] if has_conductor_record else None
    valid_passes = conductor_data["valid_passes"] if has_conductor_record else None
    total_reported = conductor_data["total_reported"] if has_conductor_record else None
    conductor_updated_at = conductor_data["updated_at"] if has_conductor_record else None
    conductor_name = conductor_data.get("conductor_name", "") if has_conductor_record else ""
    notes = conductor_data.get("notes", "") if has_conductor_record else ""

    detected_count = detection_data["detected_count"] if has_detection_record else None
    detection_updated_at = detection_data["updated_at"] if has_detection_record else None

    difference = None
    mismatch_status = "No Data"
    status_category = "pending"  # normal | mismatch | pending | reviewed
    status_description = "Awaiting passenger counts and camera detection."

    if has_conductor_record and has_detection_record:
        difference = detected_count - total_reported
        if difference == 0:
            mismatch_status = "Consistent"
            status_category = "normal"
            status_description = "Passenger count matches conductor reported total perfectly."
        elif difference > 0:
            mismatch_status = "Discrepancy (Camera Higher)"
            status_category = "mismatch"
            status_description = f"{difference} passenger(s) detected above reported ticket/pass total. Requires physical verification (may include crew or recent boardings)."
        else:
            mismatch_status = "Discrepancy (Reported Higher)"
            status_category = "reviewed"
            status_description = f"{abs(difference)} reported ticket/pass holder(s) not currently counted by camera. May indicate alighted passengers or camera occlusion."
    elif has_conductor_record and not has_detection_record:
        mismatch_status = "Camera Pending"
        status_category = "pending"
        status_description = f"Conductor reported {total_reported} passengers. Waiting for camera detection frame."
    elif not has_conductor_record and has_detection_record:
        mismatch_status = "Conductor Count Pending"
        status_category = "pending"
        status_description = f"Camera detected {detected_count} people. Waiting for conductor ticket/pass input."

    return {
        "bus_id": bus_id,
        "trip_id": trip_id,
        "conductor_record_exists": has_conductor_record,
        "detection_record_exists": has_detection_record,
        "active_tickets": active_tickets,
        "valid_passes": valid_passes,
        "total_reported": total_reported,
        "conductor_name": conductor_name,
        "notes": notes,
        "conductor_updated_at": conductor_updated_at,
        "detected_count": detected_count,
        "detection_updated_at": detection_updated_at,
        "difference": difference,
        "has_mismatch": difference is not None and difference != 0,
        "mismatch_status": mismatch_status,
        "status_category": status_category,
        "status_description": status_description
    }


def save_checkpoint_submission(
    bus_id: str,
    route: str,
    trip_id: str,
    checkpoint: str,
    active_tickets: int,
    valid_passes: int,
    starting_onboard: int,
    other_authorized: int = 0,
    boarded: int = 0,
    alighted: int = 0,
    notes: str = "",
    conductor_id: str = "",
    camera_estimate: Optional[int] = None,
    camera_detection_time: Optional[str] = None,
    camera_status: str = "",
    period_start: Optional[str] = None,
    period_end: Optional[str] = None,
    source: str = "conductor_panel",
    skip_camera_lookup: bool = False,
    use_ticketing_totals: bool = True
) -> Dict[str, Any]:
    """
    Saves a persistent checkpoint submission record for SMART ST Conductor Panel.
    Validates:
      - All count fields are non-negative whole numbers <= 500.
      - expected_onboard = starting_onboard + boarded - alighted >= 0.
      - reported_passengers = active_tickets + valid_passes + other_authorized.
    Associates the latest available camera count snapshot if not explicitly provided.
    Never overwrites previous checkpoint submissions—appends each checkpoint event to history.
    """
    bus_id = (bus_id or "").strip()
    route = (route or "").strip()
    trip_id = (trip_id or "").strip()
    checkpoint = (checkpoint or "").strip()
    conductor_id = (conductor_id or "").strip()
    notes = (notes or "").strip()
    camera_status = (camera_status or "").strip()

    if not bus_id:
        raise ValueError("Bus registration number is required.")
    if not route:
        raise ValueError("Route is required.")
    if not trip_id:
        raise ValueError("Trip identifier is required.")
    if not checkpoint:
        raise ValueError("Current checkpoint is required.")

    # Validate numeric types and limits
    for name, val in [
        ("Active tickets", active_tickets),
        ("Valid passes", valid_passes),
        ("Other authorized passengers", other_authorized),
        ("Starting onboard count", starting_onboard),
        ("Boarded passengers", boarded),
        ("Alighted passengers", alighted),
    ]:
        if not isinstance(val, int) or isinstance(val, bool):
            raise ValueError(f"{name} must be a whole integer.")
        if val < 0:
            raise ValueError(f"{name} cannot be negative.")
        if val > MAX_PASSENGER_COUNT:
            raise ValueError(f"{name} exceeds reasonable limit ({MAX_PASSENGER_COUNT}).")

    trip = ensure_active_bus_trip(bus_id, route, trip_id, conductor_id)
    bus_trip_id = trip["id"]

    ticket_summary: Optional[Dict[str, Any]] = None
    ticketing_source = "manual"
    if use_ticketing_totals:
        try:
            try:
                from . import etm_db
            except ImportError:
                import etm_db  # type: ignore
            summary = etm_db.get_ticketing_summary(bus_id, trip_id, route)
            if summary.get("ticket_count") or summary.get("pass_count"):
                active_tickets = int(summary.get("ticket_passengers") or 0)
                valid_passes = int(summary.get("pass_passengers") or 0)
                if active_tickets > MAX_PASSENGER_COUNT:
                    raise ValueError(f"ETM ticket passengers exceed reasonable limit ({MAX_PASSENGER_COUNT}).")
                if valid_passes > MAX_PASSENGER_COUNT:
                    raise ValueError(f"ETM pass passengers exceed reasonable limit ({MAX_PASSENGER_COUNT}).")
                ticket_summary = summary
                ticketing_source = "etm"
        except ValueError:
            raise
        except Exception:
            ticket_summary = None
            ticketing_source = "manual"

    # Resolve latest camera detection if not explicitly passed. Callers that
    # know the camera is offline/stale pass skip_camera_lookup=True so a stale
    # snapshot is never attached to a new record. Even when the caller does not
    # say anything, only a detection newer than CAMERA_COUNT_STALE_SECONDS is
    # considered valid: an old checkpoint count must not masquerade as live
    # camera data.
    detection_snapshot = None
    if camera_estimate is None and not skip_camera_lookup:
        detection_snapshot = get_latest_detection(bus_id)
        if detection_snapshot and detection_snapshot.get("detected_count") is not None:
            age = _age_seconds(detection_snapshot.get("updated_at"))
            if age is not None and age <= CAMERA_COUNT_STALE_SECONDS:
                camera_estimate = detection_snapshot["detected_count"]
                if not camera_detection_time:
                    camera_detection_time = detection_snapshot.get("updated_at")
            else:
                camera_status = camera_status or "stale"
    if camera_estimate is not None and not camera_status:
        camera_status = "connected"

    metrics = compute_checkpoint_metrics(
        active_tickets=active_tickets,
        valid_passes=valid_passes,
        other_authorized=other_authorized,
        starting_onboard=starting_onboard,
        boarded=boarded,
        alighted=alighted,
        camera_estimate=camera_estimate,
    )
    reported_passengers = metrics["reported_passengers"]
    expected_onboard = metrics["expected_onboard"]
    difference = metrics["difference"]
    difference_abs = metrics["difference_abs"]
    reported_difference = metrics["reported_difference"]
    comparison_status = metrics["comparison_status"]

    if expected_onboard < 0:
        raise ValueError(
            f"Invalid passenger movement: starting onboard ({starting_onboard}) + boarded ({boarded}) "
            f"- alighted ({alighted}) yields negative expected occupancy ({expected_onboard})."
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    period_start_iso = (period_start or "").strip() or _derive_period_start(bus_id, trip_id, now_iso)
    period_end_iso = (period_end or "").strip() or now_iso

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO checkpoint_submissions (
                bus_trip_id, bus_id, route, trip_id, checkpoint, conductor_id,
                active_tickets, valid_passes, other_authorized,
                starting_onboard, boarded, alighted,
                reported_passengers, expected_onboard,
                camera_estimate, camera_detection_time,
                difference, difference_abs, reported_difference,
                comparison_status, camera_status, period_start, period_end, source,
                ticket_count, ticket_passengers, pass_count, pass_passengers,
                ticket_revenue, ticketing_source,
                notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            bus_trip_id, bus_id, route, trip_id, checkpoint, conductor_id,
            active_tickets, valid_passes, other_authorized,
            starting_onboard, boarded, alighted,
            reported_passengers, expected_onboard,
            camera_estimate, camera_detection_time or "",
            difference, difference_abs, reported_difference,
            comparison_status, camera_status, period_start_iso, period_end_iso, source,
            (ticket_summary or {}).get("ticket_count", 0),
            (ticket_summary or {}).get("ticket_passengers", 0),
            (ticket_summary or {}).get("pass_count", 0),
            (ticket_summary or {}).get("pass_passengers", 0),
            (ticket_summary or {}).get("ticket_revenue", 0.0),
            ticketing_source,
            notes, now_iso
        ))
        record_id = cursor.lastrowid

        cursor.execute("""
            INSERT INTO expected_passenger_counts
            (bus_trip_id, checkpoint_submission_id, bus_id, route, trip_id, checkpoint,
             starting_onboard, boarded, alighted, expected_count, reported_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            bus_trip_id, record_id, bus_id, route, trip_id, checkpoint,
            starting_onboard, boarded, alighted, expected_onboard, reported_passengers, now_iso,
        ))
        expected_count_id = cursor.lastrowid
        vision_count_id = None
        if camera_estimate is not None:
            inference_time_ms = float((detection_snapshot or {}).get("inference_time_ms") or 0.0)
            cursor.execute("""
                INSERT INTO computer_vision_counts
                (bus_trip_id, checkpoint_submission_id, bus_id, route, trip_id, checkpoint,
                 detected_count, inference_time_ms, camera_status, captured_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                bus_trip_id, record_id, bus_id, route, trip_id, checkpoint,
                camera_estimate, inference_time_ms, camera_status,
                camera_detection_time or now_iso, now_iso,
            ))
            vision_count_id = cursor.lastrowid

        # Also sync latest values into conductor_records table for existing dashboard views
        cursor.execute("""
            INSERT INTO conductor_records
            (bus_id, trip_id, active_tickets, valid_passes, total_reported, notes, conductor_name, bus_trip_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bus_id, trip_id) DO UPDATE SET
                active_tickets = excluded.active_tickets,
                valid_passes = excluded.valid_passes,
                total_reported = excluded.total_reported,
                notes = excluded.notes,
                conductor_name = excluded.conductor_name,
                bus_trip_id = excluded.bus_trip_id,
                updated_at = excluded.updated_at
        """, (bus_id, trip_id, active_tickets, valid_passes, reported_passengers, notes, conductor_id, bus_trip_id, now_iso))

        conn.commit()

        return {
            "id": record_id,
            "bus_trip_id": bus_trip_id,
            "expected_count_id": expected_count_id,
            "vision_count_id": vision_count_id,
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "checkpoint": checkpoint,
            "conductor_id": conductor_id,
            "active_tickets": active_tickets,
            "valid_passes": valid_passes,
            "other_authorized": other_authorized,
            "starting_onboard": starting_onboard,
            "boarded": boarded,
            "alighted": alighted,
            "reported_passengers": reported_passengers,
            "expected_onboard": expected_onboard,
            "camera_estimate": camera_estimate,
            "camera_detection_time": camera_detection_time or "",
            "difference": difference,
            "difference_abs": difference_abs,
            "reported_difference": reported_difference,
            "comparison_status": comparison_status,
            "comparison_status_label": metrics["comparison_status_label"],
            "camera_status": camera_status,
            "period_start": period_start_iso,
            "period_end": period_end_iso,
            "source": source,
            "ticket_count": (ticket_summary or {}).get("ticket_count", 0),
            "ticket_passengers": (ticket_summary or {}).get("ticket_passengers", 0),
            "pass_count": (ticket_summary or {}).get("pass_count", 0),
            "pass_passengers": (ticket_summary or {}).get("pass_passengers", 0),
            "ticket_revenue": (ticket_summary or {}).get("ticket_revenue", 0.0),
            "ticketing_source": ticketing_source,
            "ticket_summary": ticket_summary,
            "notes": notes,
            "created_at": now_iso
        }
    finally:
        conn.close()


def _derive_period_start(bus_id: str, trip_id: str, fallback_iso: str) -> str:
    """
    Derives the start of the counting period for a checkpoint.

    The period starts when the previous checkpoint of the same trip was recorded.
    For the first checkpoint of a trip the period starts at the trip's first
    recorded checkpoint (or the submission time when nothing exists yet).
    """
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT created_at FROM checkpoint_submissions
            WHERE bus_id = ? AND trip_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 1
            """,
            (bus_id, trip_id)
        )
        row = cursor.fetchone()
        if row and row[0]:
            return row[0]
        return fallback_iso
    finally:
        conn.close()


def set_checkpoint_alert_id(record_id: int, alert_id: Optional[int]) -> None:
    """Links a saved checkpoint record to the mismatch alert it produced (if any)."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE checkpoint_submissions SET alert_id = ? WHERE id = ?",
            (alert_id, record_id)
        )
        conn.commit()
    finally:
        conn.close()



def get_checkpoint_history(
    bus_id: Optional[str] = None,
    trip_id: Optional[str] = None,
    limit: int = 50
) -> List[Dict[str, Any]]:
    """
    Retrieves checkpoint submission history, sorted newest first.
    Filters by bus_id and optional trip_id if provided.
    """
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM checkpoint_submissions"
        params: List[Any] = []
        conditions = []

        if bus_id and bus_id.strip():
            conditions.append("bus_id = ?")
            params.append(bus_id.strip())

        if trip_id and trip_id.strip():
            conditions.append("trip_id = ?")
            params.append(trip_id.strip())

        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        query += " ORDER BY created_at DESC, id DESC LIMIT ?"
        params.append(max(1, min(limit, 200)))

        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_latest_checkpoint(
    bus_id: str,
    trip_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Retrieves the most recent checkpoint submission for a bus and optional trip."""
    history = get_checkpoint_history(bus_id=bus_id, trip_id=trip_id, limit=1)
    return history[0] if history else None


def get_checkpoint_by_id(record_id: int) -> Optional[Dict[str, Any]]:
    """Retrieves a specific checkpoint record by its unique database ID."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM checkpoint_submissions WHERE id = ?", (record_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_routes() -> List[Dict[str, Any]]:
    """
    Returns the real routes known to the system.

    Sources: routes assigned to registered buses and routes recorded on saved
    checkpoint submissions. No routes are invented.
    """
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT route,
                   COUNT(DISTINCT bus_id) AS bus_count,
                   MAX(created_at) AS last_activity
            FROM (
                SELECT route, id AS bus_id, NULL AS created_at FROM registered_buses
                UNION ALL
                SELECT route, bus_id, created_at FROM checkpoint_submissions
            )
            WHERE route IS NOT NULL AND TRIM(route) != ''
            GROUP BY route
            ORDER BY route ASC
        """)
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def get_checkpoint_options(route: Optional[str] = None, bus_id: Optional[str] = None) -> List[str]:
    """
    Returns checkpoint names that really exist in the database.

    Used to populate the checkpoint selector on the Conductor Panel without
    inventing checkpoint records.
    """
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        query = """
            SELECT checkpoint, MAX(created_at) AS last_used, COUNT(*) AS uses
            FROM checkpoint_submissions
            WHERE checkpoint IS NOT NULL AND TRIM(checkpoint) != ''
        """
        params: List[Any] = []
        if route and route.strip():
            query += " AND route = ?"
            params.append(route.strip())
        if bus_id and bus_id.strip():
            query += " AND bus_id = ?"
            params.append(bus_id.strip())
        query += " GROUP BY checkpoint ORDER BY last_used DESC, checkpoint ASC"
        cursor.execute(query, tuple(params))
        return [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()


def get_route_stops(route: str, bus_id: Optional[str] = None) -> List[str]:
    """Returns route endpoints plus checkpoints already recorded for the route."""
    route = _clean_identifier(route, "Route", max_length=100)
    stops = [
        part.strip()
        for part in re.split(r"\s+[-\u2013\u2014]\s+", route)
        if part.strip()
    ]
    stops.extend(get_checkpoint_options(route=route, bus_id=bus_id))

    unique_stops: List[str] = []
    seen = set()
    for stop in stops:
        key = stop.casefold()
        if key in seen:
            continue
        seen.add(key)
        unique_stops.append(stop)
    return unique_stops


def record_camera_session(
    bus_id: str,
    camera_status: str = "idle",
    model_status: str = "unknown",
    message: str = "",
    session_id: str = ""
) -> Dict[str, Any]:
    """
    Stores the latest camera session heartbeat reported by the monitoring page.

    This lets the Conductor Panel show the real camera state (connecting,
    permission denied, model unavailable, ...) without starting a second camera.
    """
    bus_id = (bus_id or "").strip()
    if not bus_id:
        raise ValueError("Bus registration number is required.")
    now_iso = datetime.now(timezone.utc).isoformat()
    camera_status = (camera_status or "idle").strip()
    model_status = (model_status or "unknown").strip()
    message = (message or "").strip()
    session_id = (session_id or "").strip()

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO camera_sessions
            (bus_id, session_id, camera_status, model_status, message, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(bus_id) DO UPDATE SET
                session_id = excluded.session_id,
                camera_status = excluded.camera_status,
                model_status = excluded.model_status,
                message = excluded.message,
                updated_at = excluded.updated_at
        """, (bus_id, session_id, camera_status, model_status, message, now_iso))
        conn.commit()
        return {
            "bus_id": bus_id,
            "session_id": session_id,
            "camera_status": camera_status,
            "model_status": model_status,
            "message": message,
            "updated_at": now_iso
        }
    finally:
        conn.close()


def get_camera_session(bus_id: str) -> Optional[Dict[str, Any]]:
    """Returns the last recorded camera session heartbeat for a bus."""
    bus_id = (bus_id or "").strip()
    if not bus_id:
        return None
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM camera_sessions WHERE bus_id = ?", (bus_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def _age_seconds(iso_timestamp: Optional[str]) -> Optional[float]:
    """Returns the age of an ISO timestamp in seconds (None when unknown)."""
    if not iso_timestamp:
        return None
    try:
        parsed = datetime.fromisoformat(iso_timestamp)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return round((datetime.now(timezone.utc) - parsed).total_seconds(), 1)
    except Exception:
        return None


def get_camera_state(
    bus_id: str,
    model_available: bool = True,
    stale_after_seconds: int = CAMERA_COUNT_STALE_SECONDS
) -> Dict[str, Any]:
    """
    Returns the shared camera state used by the Conductor Panel.

    The passenger count itself always comes from the real OpenCV/YOLO inference
    pipeline (latest_detections, written by POST /api/detect). A missing count is
    reported as unavailable and is never converted to zero.
    """
    bus_id = (bus_id or "").strip()
    detection = get_latest_detection(bus_id) if bus_id else None
    session = get_camera_session(bus_id) if bus_id else None

    count = detection["detected_count"] if detection else None
    detected_at = detection["updated_at"] if detection else None
    age = _age_seconds(detected_at)
    stale = bool(age is not None and age > stale_after_seconds)

    camera_status = (session or {}).get("camera_status") or "idle"
    model_status = (session or {}).get("model_status") or "unknown"
    message = (session or {}).get("message") or ""

    if not model_available:
        status = "model_unavailable"
        message = message or "YOLO model is not loaded on the backend."
    elif camera_status in ("permission_denied", "unavailable", "error"):
        status = camera_status
    elif camera_status == "connecting":
        status = "connecting"
    elif count is None:
        status = "unavailable"
        message = message or "No camera frames have been received for this bus yet."
    elif stale:
        status = "stale"
        message = message or f"Last camera count is {int(age)} seconds old."
    else:
        status = "connected"

    return {
        "bus_id": bus_id,
        "count": count,
        "updated_at": detected_at,
        "age_seconds": age,
        "stale": stale,
        "status": status,
        "camera_status": camera_status,
        "model_status": model_status,
        "message": message,
        "session_updated_at": (session or {}).get("updated_at"),
        "inference_time_ms": (detection or {}).get("inference_time_ms", 0.0),
        "source": "yolo_opencv",
        "stale_after_seconds": stale_after_seconds,
    }


