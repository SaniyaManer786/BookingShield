"""
SMART ST Control Center - Mismatch Alert & Checker Dispatch Workflow

Backend-owned workflow that consumes saved checkpoint submissions:

    checkpoint submission -> comparison -> mismatch alert -> checker dispatch

Design rules implemented here:
  * Thresholds live in the backend only (never in frontend code) and can be
    configured through environment variables.
  * Alert and dispatch creation is idempotent: the same checkpoint submission
    can never produce a second alert or a second dispatch, no matter how often
    the record is fetched, refreshed or replayed.
  * A camera count is an estimate. An alert is a request for human
    verification, never a finding of fare evasion.
"""

import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    from backend import conductor_db
except ImportError:  # pragma: no cover - allows direct execution of the module
    import conductor_db  # type: ignore

# ---------------------------------------------------------------------------
# Server-side thresholds (never exposed to the frontend)
# ---------------------------------------------------------------------------
DEFAULT_MISMATCH_THRESHOLD = 2
DEFAULT_HIGH_MISMATCH_THRESHOLD = 4


def get_mismatch_threshold() -> int:
    """Minimum absolute passenger variance that raises a mismatch alert."""
    raw = os.environ.get("MISMATCH_THRESHOLD")
    if raw is None or raw.strip() == "":
        return DEFAULT_MISMATCH_THRESHOLD
    try:
        value = int(float(raw.strip()))
        return value if value >= 0 else DEFAULT_MISMATCH_THRESHOLD
    except ValueError:
        return DEFAULT_MISMATCH_THRESHOLD


def get_high_mismatch_threshold() -> int:
    """Absolute passenger variance that is flagged as a high severity alert."""
    raw = os.environ.get("HIGH_MISMATCH_THRESHOLD")
    if raw is None or raw.strip() == "":
        return DEFAULT_HIGH_MISMATCH_THRESHOLD
    try:
        value = int(float(raw.strip()))
        return value if value >= 0 else DEFAULT_HIGH_MISMATCH_THRESHOLD
    except ValueError:
        return DEFAULT_HIGH_MISMATCH_THRESHOLD


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_minutes_ago(minutes: float) -> str:
    return datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() - minutes * 60, tz=timezone.utc
    ).isoformat()


SEED_CHECKERS = [
    {"id": "CHK-018", "name": "Pravin Deshmukh", "availability": "Available", "bus": "", "location": "Pune - Shivajinagar", "task": "Standby"},
    {"id": "CHK-024", "name": "Meena Patil", "availability": "On inspection", "bus": "MH-11-AX-2208", "location": "Indapur Bypass", "task": "Passenger check"},
    {"id": "CHK-031", "name": "Rahul Gaikwad", "availability": "On inspection", "bus": "MH-09-CV-3372", "location": "Karad Bus Stand", "task": "Mismatch verification"},
    {"id": "CHK-012", "name": "Sunita More", "availability": "Available", "bus": "", "location": "Pune - Swargate", "task": "Standby"},
    {"id": "CHK-027", "name": "Ajay Jadhav", "availability": "Available", "bus": "", "location": "Lonavala Depot", "task": "Standby"},
]

# Existing demonstration alerts, migrated into the database so the Mismatch
# Alerts page keeps working from a single backend source of truth.
SEED_ALERTS = [
    {"code": "ALT-24081", "bus_id": "MH-12-QW-4821", "route": "Pune – Mumbai", "checkpoint": "Lonavala", "reported": 46, "expected": 44, "camera": None, "difference": 2, "severity": "Medium", "status": "New", "minutes_ago": 42},
    {"code": "ALT-24080", "bus_id": "MH-09-CV-3372", "route": "Pune – Kolhapur", "checkpoint": "Karad", "reported": 49, "expected": 45, "camera": None, "difference": 4, "severity": "High", "status": "New", "minutes_ago": 46},
    {"code": "ALT-24079", "bus_id": "MH-11-AX-2208", "route": "Pune – Solapur", "checkpoint": "Indapur", "reported": 43, "expected": 41, "camera": None, "difference": 2, "severity": "Medium", "status": "Under Review", "minutes_ago": 63},
    {"code": "ALT-24077", "bus_id": "MH-12-JK-9083", "route": "Pune – Mumbai", "checkpoint": "Khopoli", "reported": 51, "expected": 47, "camera": None, "difference": 4, "severity": "High", "status": "New", "minutes_ago": 88},
    {"code": "ALT-24075", "bus_id": "MH-12-KL-2811", "route": "Pune – Satara", "checkpoint": "Shirwal", "reported": 40, "expected": 39, "camera": None, "difference": 1, "severity": "Low", "status": "Resolved", "minutes_ago": 112},
    {"code": "ALT-24072", "bus_id": "MH-14-TR-7104", "route": "Pune – Nashik", "checkpoint": "Sangamner", "reported": 44, "expected": 42, "camera": None, "difference": 2, "severity": "Medium", "status": "Under Review", "minutes_ago": 136},
]


def init_db() -> None:
    """Creates the alert / dispatch schema and seeds the demonstration roster."""
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS mismatch_alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alert_code TEXT UNIQUE,
                checkpoint_submission_id INTEGER UNIQUE,
                bus_id TEXT NOT NULL,
                route TEXT DEFAULT '',
                trip_id TEXT DEFAULT '',
                checkpoint TEXT DEFAULT '',
                reported_passengers INTEGER DEFAULT 0,
                expected_onboard INTEGER DEFAULT 0,
                camera_estimate INTEGER,
                difference INTEGER,
                reported_difference INTEGER,
                severity TEXT NOT NULL DEFAULT 'Low',
                status TEXT NOT NULL DEFAULT 'New',
                source TEXT NOT NULL DEFAULT 'checkpoint',
                created_at TEXT NOT NULL
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS checkers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                availability TEXT NOT NULL DEFAULT 'Available',
                bus_id TEXT DEFAULT '',
                location TEXT DEFAULT '',
                task TEXT DEFAULT 'Standby',
                updated_at TEXT NOT NULL
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS checker_dispatches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alert_id INTEGER UNIQUE,
                checker_id TEXT NOT NULL,
                checker_name TEXT NOT NULL,
                bus_id TEXT NOT NULL,
                route TEXT DEFAULT '',
                trip_id TEXT DEFAULT '',
                checkpoint TEXT DEFAULT '',
                location TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Dispatched',
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_alert_bus ON mismatch_alerts(bus_id, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_dispatch_status ON checker_dispatches(status, created_at DESC)")

        # Seed the checker roster once
        cursor.execute("SELECT COUNT(*) FROM checkers")
        if cursor.fetchone()[0] == 0:
            now = _now_iso()
            for checker in SEED_CHECKERS:
                cursor.execute("""
                    INSERT INTO checkers (id, name, availability, bus_id, location, task, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (
                    checker["id"], checker["name"], checker["availability"], checker["bus"],
                    checker["location"], checker["task"], now
                ))

        # Seed the demonstration alert history once
        cursor.execute("SELECT COUNT(*) FROM mismatch_alerts")
        if cursor.fetchone()[0] == 0:
            for alert in SEED_ALERTS:
                cursor.execute("""
                    INSERT INTO mismatch_alerts
                    (alert_code, checkpoint_submission_id, bus_id, route, trip_id, checkpoint,
                     reported_passengers, expected_onboard, camera_estimate, difference,
                     reported_difference, severity, status, source, created_at)
                    VALUES (?, NULL, ?, ?, '', ?, ?, ?, ?, ?, NULL, ?, ?, 'seed', ?)
                """, (
                    alert["code"], alert["bus_id"], alert["route"], alert["checkpoint"],
                    alert["reported"], alert["expected"], alert["camera"], alert["difference"],
                    alert["severity"], alert["status"], _iso_minutes_ago(alert["minutes_ago"])
                ))

        conn.commit()
    finally:
        conn.close()


def classify_severity(difference: int) -> str:
    """Maps an absolute passenger variance onto a severity label."""
    variance = abs(difference)
    if variance >= get_high_mismatch_threshold():
        return "High"
    if variance >= get_mismatch_threshold():
        return "Medium"
    return "Low"


def _next_alert_code(cursor: sqlite3.Cursor) -> str:
    """Generates the next sequential alert code (ALT-#####)."""
    cursor.execute("SELECT alert_code FROM mismatch_alerts WHERE alert_code LIKE 'ALT-%' ORDER BY alert_code DESC LIMIT 1")
    row = cursor.fetchone()
    last_number = 0
    if row and row[0]:
        try:
            last_number = int(str(row[0]).split("-")[-1])
        except ValueError:
            last_number = 0
    return f"ALT-{last_number + 1:05d}"


def process_checkpoint_record(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Runs the mismatch workflow for a saved checkpoint submission.

    Idempotent: a checkpoint submission id can only ever create one alert and
    one checker dispatch. Returns the alert dict, or None when the record does
    not exceed the backend mismatch threshold.
    """
    record_id = record.get("id")
    if record_id is None:
        return None

    difference = record.get("difference")
    if difference is None:
        # No camera estimate -> nothing can be compared, so no alert is raised.
        return None

    if abs(difference) < get_mismatch_threshold():
        return None

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM mismatch_alerts WHERE checkpoint_submission_id = ?", (record_id,))
        existing = cursor.fetchone()
        if existing:
            # Already processed - never raise a duplicate alert.
            return dict(existing)

        severity = classify_severity(difference)
        alert_code = _next_alert_code(cursor)
        now_iso = _now_iso()

        cursor.execute("""
            INSERT INTO mismatch_alerts
            (alert_code, checkpoint_submission_id, bus_id, route, trip_id, checkpoint,
             reported_passengers, expected_onboard, camera_estimate, difference,
             reported_difference, severity, status, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', 'checkpoint', ?)
        """, (
            alert_code, record_id, record.get("bus_id", ""), record.get("route", ""),
            record.get("trip_id", ""), record.get("checkpoint", ""),
            record.get("reported_passengers", 0), record.get("expected_onboard", 0),
            record.get("camera_estimate"), difference, record.get("reported_difference"),
            severity, now_iso
        ))
        alert_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    conductor_db.set_checkpoint_alert_id(record_id, alert_id)

    alert = get_alert_by_id(alert_id)
    if alert:
        dispatch_checker_for_alert(alert)
        alert = get_alert_by_id(alert_id)
    return alert


def dispatch_checker_for_alert(alert: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Dispatches an available checker for a mismatch alert.

    Idempotent: an alert can only ever have one automatic dispatch.
    """
    alert_id = alert.get("id")
    if alert_id is None:
        return None

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM checker_dispatches WHERE alert_id = ?", (alert_id,))
        if cursor.fetchone():
            return None  # already dispatched

        cursor.execute("""
            SELECT id, name FROM checkers
            WHERE availability = 'Available'
            ORDER BY id ASC LIMIT 1
        """)
        checker = cursor.fetchone()
        if not checker:
            return None

        now_iso = _now_iso()
        cursor.execute("""
            INSERT INTO checker_dispatches
            (alert_id, checker_id, checker_name, bus_id, route, trip_id, checkpoint, location, status, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Dispatched', ?, ?)
        """, (
            alert_id, checker["id"], checker["name"], alert.get("bus_id", ""),
            alert.get("route", ""), alert.get("trip_id", ""), alert.get("checkpoint", ""),
            alert.get("checkpoint", "") or "Depot",
            "Camera count variance requires physical passenger verification.",
            now_iso
        ))
        dispatch_id = cursor.lastrowid

        cursor.execute("""
            UPDATE checkers
            SET availability = 'On inspection', bus_id = ?, task = 'Mismatch verification', updated_at = ?
            WHERE id = ?
        """, (alert.get("bus_id", ""), now_iso, checker["id"]))
        conn.commit()
    finally:
        conn.close()

    return get_dispatch_by_id(dispatch_id)


def create_manual_dispatch(
    bus_id: str,
    checker_id: str,
    location: str = "",
    checkpoint: str = "",
    notes: str = ""
) -> Dict[str, Any]:
    """Creates a manual checker assignment from the Checker Dispatch page."""
    bus_id = (bus_id or "").strip()
    if not bus_id:
        raise ValueError("Bus registration number is required.")

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM checkers WHERE id = ?", (checker_id,))
        checker = cursor.fetchone()
        if not checker:
            raise ValueError("Unknown checker identifier.")

        now_iso = _now_iso()
        cursor.execute("""
            INSERT INTO checker_dispatches
            (alert_id, checker_id, checker_name, bus_id, route, trip_id, checkpoint, location, status, notes, created_at)
            VALUES (NULL, ?, ?, ?, '', '', ?, ?, 'Dispatched', ?, ?)
        """, (
            checker["id"], checker["name"], bus_id, checkpoint, location,
            (notes or "Manual checker assignment.").strip(), now_iso
        ))
        dispatch_id = cursor.lastrowid

        cursor.execute("""
            UPDATE checkers
            SET availability = 'On inspection', bus_id = ?, task = 'Passenger check', updated_at = ?
            WHERE id = ?
        """, (bus_id, now_iso, checker["id"]))
        conn.commit()
    finally:
        conn.close()

    return get_dispatch_by_id(dispatch_id)


def get_alert_by_id(alert_id: int) -> Optional[Dict[str, Any]]:
    """Returns a single alert with its dispatch (if any)."""
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM mismatch_alerts WHERE id = ?", (alert_id,))
        row = cursor.fetchone()
        if not row:
            return None
        alert = dict(row)
        cursor.execute("SELECT * FROM checker_dispatches WHERE alert_id = ?", (alert_id,))
        dispatch = cursor.fetchone()
        alert["dispatch"] = dict(dispatch) if dispatch else None
        return alert
    finally:
        conn.close()


def get_dispatch_by_id(dispatch_id: int) -> Optional[Dict[str, Any]]:
    """Returns a single checker dispatch record."""
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM checker_dispatches WHERE id = ?", (dispatch_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_alerts(
    bus_id: Optional[str] = None,
    route: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """Returns mismatch alerts, newest first, with optional filters."""
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM mismatch_alerts"
        conditions = []
        params: List[Any] = []
        if bus_id and bus_id.strip():
            conditions.append("bus_id = ?")
            params.append(bus_id.strip())
        if route and route.strip():
            conditions.append("route = ?")
            params.append(route.strip())
        if severity and severity.strip():
            conditions.append("severity = ?")
            params.append(severity.strip())
        if status and status.strip():
            conditions.append("status = ?")
            params.append(status.strip())
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY created_at DESC, id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        cursor.execute(query, tuple(params))
        alerts = [dict(row) for row in cursor.fetchall()]

        for alert in alerts:
            cursor.execute("SELECT * FROM checker_dispatches WHERE alert_id = ?", (alert["id"],))
            dispatch = cursor.fetchone()
            alert["dispatch"] = dict(dispatch) if dispatch else None
        return alerts
    finally:
        conn.close()


def update_alert_status(alert_id: int, status: str) -> Optional[Dict[str, Any]]:
    """Updates the workflow status of an alert (New / Under Review / Resolved)."""
    allowed = {"New", "Under Review", "Resolved"}
    status = (status or "").strip()
    if status not in allowed:
        raise ValueError(f"Status must be one of: {', '.join(sorted(allowed))}.")

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM mismatch_alerts WHERE id = ?", (alert_id,))
        if not cursor.fetchone():
            return None
        cursor.execute("UPDATE mismatch_alerts SET status = ? WHERE id = ?", (status, alert_id))
        conn.commit()
    finally:
        conn.close()

    return get_alert_by_id(alert_id)


def list_dispatches(bus_id: Optional[str] = None, status: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
    """Returns checker dispatches, newest first."""
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM checker_dispatches"
        conditions = []
        params: List[Any] = []
        if bus_id and bus_id.strip():
            conditions.append("bus_id = ?")
            params.append(bus_id.strip())
        if status and status.strip():
            conditions.append("status = ?")
            params.append(status.strip())
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY created_at DESC, id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        cursor.execute(query, tuple(params))
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def list_checkers() -> List[Dict[str, Any]]:
    """Returns the checker roster."""
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM checkers ORDER BY id ASC")
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def list_inspections(limit: int = 100) -> List[Dict[str, Any]]:
    """
    Returns the inspection activity log built from dispatches and seed records.

    The Inspection History page reads this so completed checker visits keep
    working after dispatches are stored in the database.
    """
    seed_history = [
        {"inspection_id": "INSP-6018", "bus_id": "MH-14-BT-1906", "route": "Pune – Nashik", "checker": "Pravin Deshmukh", "location": "Sangamner Bus Stand", "mismatch": "No", "outcome": "No Mismatch Found"},
        {"inspection_id": "INSP-6017", "bus_id": "MH-11-AX-2208", "route": "Pune – Solapur", "checker": "Meena Patil", "location": "Indapur Bypass", "mismatch": "Yes · 2", "outcome": "Mismatch Confirmed"},
        {"inspection_id": "INSP-6016", "bus_id": "MH-09-CV-3372", "route": "Pune – Kolhapur", "checker": "Rahul Gaikwad", "location": "Karad Bus Stand", "mismatch": "Pending", "outcome": "Inspection Pending"},
        {"inspection_id": "INSP-6015", "bus_id": "MH-12-KL-2811", "route": "Pune – Satara", "checker": "Sunita More", "location": "Shirwal Checkpoint", "mismatch": "No", "outcome": "No Mismatch Found"},
        {"inspection_id": "INSP-6014", "bus_id": "MH-12-QW-4821", "route": "Pune – Mumbai", "checker": "Ajay Jadhav", "location": "Lonavala Depot", "mismatch": "Yes · 1", "outcome": "Mismatch Confirmed"},
    ]

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT d.*, a.route AS alert_route, a.severity
            FROM checker_dispatches d
            LEFT JOIN mismatch_alerts a ON a.id = d.alert_id
            ORDER BY d.created_at DESC, d.id DESC LIMIT ?
        """, (max(1, min(int(limit), 500)),))
        rows = [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()

    history = []
    for index, row in enumerate(rows):
        history.append({
            "inspection_id": f"INSP-{7000 + index}",
            "bus_id": row.get("bus_id", ""),
            "route": row.get("alert_route") or row.get("route", ""),
            "checker": row.get("checker_name", ""),
            "location": row.get("location", ""),
            "mismatch": "Pending" if row.get("status") == "Dispatched" else "Yes",
            "outcome": "Inspection Pending" if row.get("status") == "Dispatched" else "Mismatch Verified",
            "created_at": row.get("created_at", ""),
        })
    return history + [
        {**item, "created_at": _iso_minutes_ago(30 + index * 20)}
        for index, item in enumerate(seed_history)
    ]
