"""
SMART ST Control Center - Conductor Panel Persistence Module
SQLite-backed storage for conductor passenger accounting and real-time detection syncing.
"""

import os
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


def get_db_connection() -> sqlite3.Connection:
    """Returns an SQLite connection with Row row_factory."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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

        # Safe migration for existing DB instances: check if camera_detection_time column exists
        cursor.execute("PRAGMA table_info(checkpoint_submissions)")
        existing_cols = [r[1] for r in cursor.fetchall()]
        if "camera_detection_time" not in existing_cols:
            cursor.execute("ALTER TABLE checkpoint_submissions ADD COLUMN camera_detection_time TEXT DEFAULT ''")

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
        cursor.execute("""
            INSERT INTO conductor_records
            (bus_id, trip_id, active_tickets, valid_passes, total_reported, notes, conductor_name, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bus_id, trip_id) DO UPDATE SET
                active_tickets = excluded.active_tickets,
                valid_passes = excluded.valid_passes,
                total_reported = excluded.total_reported,
                notes = excluded.notes,
                conductor_name = excluded.conductor_name,
                updated_at = excluded.updated_at
        """, (bus_id, trip_id, active_tickets, valid_passes, total_reported, notes.strip(), conductor_name.strip(), now_iso))
        conn.commit()

        return {
            "bus_id": bus_id,
            "trip_id": trip_id,
            "active_tickets": active_tickets,
            "valid_passes": valid_passes,
            "total_reported": total_reported,
            "notes": notes.strip(),
            "conductor_name": conductor_name.strip(),
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
        cursor.execute("""
            INSERT INTO latest_detections (bus_id, detected_count, inference_time_ms, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(bus_id) DO UPDATE SET
                detected_count = excluded.detected_count,
                inference_time_ms = excluded.inference_time_ms,
                updated_at = excluded.updated_at
        """, (bus_id, count, inference_time_ms, now_iso))
        conn.commit()

        return {
            "bus_id": bus_id,
            "detected_count": count,
            "inference_time_ms": inference_time_ms,
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
    camera_detection_time: Optional[str] = None
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
        if val > 500:
            raise ValueError(f"{name} exceeds reasonable limit (500).")

    reported_passengers = active_tickets + valid_passes + other_authorized
    expected_onboard = starting_onboard + boarded - alighted

    if expected_onboard < 0:
        raise ValueError(
            f"Invalid passenger movement: starting onboard ({starting_onboard}) + boarded ({boarded}) "
            f"- alighted ({alighted}) yields negative expected occupancy ({expected_onboard})."
        )

    # Resolve latest camera detection if not explicitly passed
    if camera_estimate is None:
        det = get_latest_detection(bus_id)
        if det and det.get("detected_count") is not None:
            camera_estimate = det["detected_count"]
            if not camera_detection_time:
                camera_detection_time = det.get("updated_at")

    if camera_estimate is not None:
        difference = camera_estimate - expected_onboard
        if difference == 0:
            comparison_status = "Match"
        else:
            comparison_status = "Discrepancy — verify"
    else:
        difference = None
        comparison_status = "Comparison unavailable"

    now_iso = datetime.now(timezone.utc).isoformat()

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO checkpoint_submissions (
                bus_id, route, trip_id, checkpoint, conductor_id,
                active_tickets, valid_passes, other_authorized,
                starting_onboard, boarded, alighted,
                reported_passengers, expected_onboard,
                camera_estimate, camera_detection_time, difference, comparison_status,
                notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            bus_id, route, trip_id, checkpoint, conductor_id,
            active_tickets, valid_passes, other_authorized,
            starting_onboard, boarded, alighted,
            reported_passengers, expected_onboard,
            camera_estimate, camera_detection_time or "", difference, comparison_status,
            notes, now_iso
        ))
        record_id = cursor.lastrowid

        # Also sync latest values into conductor_records table for existing dashboard views
        cursor.execute("""
            INSERT INTO conductor_records
            (bus_id, trip_id, active_tickets, valid_passes, total_reported, notes, conductor_name, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bus_id, trip_id) DO UPDATE SET
                active_tickets = excluded.active_tickets,
                valid_passes = excluded.valid_passes,
                total_reported = excluded.total_reported,
                notes = excluded.notes,
                conductor_name = excluded.conductor_name,
                updated_at = excluded.updated_at
        """, (bus_id, trip_id, active_tickets, valid_passes, reported_passengers, notes, conductor_id, now_iso))

        conn.commit()

        return {
            "id": record_id,
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
            "comparison_status": comparison_status,
            "notes": notes,
            "created_at": now_iso
        }
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

