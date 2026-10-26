"""
SMART ST Control Center - ETM Ticketing and Passenger Pass Persistence

Stores route fare settings, issued tickets, registered passes and the derived
passenger totals used by the conductor checkpoint and analytics workflows.
"""

import hashlib
import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

try:
    from backend import conductor_db
except ImportError:
    import conductor_db  # type: ignore

DEFAULT_FULL_FARE = 120.0
DEFAULT_HALF_FARE = 60.0
DEFAULT_FREE_FARE = 0.0
DEFAULT_CURRENCY = "INR"
DEFAULT_MISMATCH_TOLERANCE = 2
MAX_TICKET_QUANTITY = 500
MAX_PASSENGERS_PER_PASS = 500

TICKET_STATUSES = {"Valid", "Cancelled"}
PASS_STATUSES = {"Valid", "Cancelled"}
FARE_BASES = {"full", "half", "free"}
CATEGORY_CODE_PATTERN = re.compile(r"^[A-Z0-9_]{1,32}$")
PASS_NUMBER_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9 ._/-]{0,59}$")


class IdempotencyConflictError(ValueError):
    """Raised when a client request ID is reused with a different ticket."""

PASSENGER_CATEGORIES = [
    ("FULL", "Adult male", "full", 1),
    ("HALF", "Female passenger", "half", 2),
    ("FREE", "Senior citizen", "free", 3),
    ("CHILD", "Child", "half", 4),
    ("OTHER", "Other passenger", "full", 5),
]

LEGACY_CATEGORY_LABELS = {
    "FULL": "Full fare passenger",
    "HALF": "Half fare passenger",
    "FREE": "Free fare passenger",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc_today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _clean_text(value: Any, field: str, required: bool = False, max_length: int = 200) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"{field} is required.")
    if len(text) > max_length:
        raise ValueError(f"{field} must be at most {max_length} characters.")
    return text


def _number(value: Any, field: str, minimum: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number.") from None
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError(f"{field} must be a finite number.")
    if number < minimum:
        raise ValueError(f"{field} cannot be negative.")
    return round(number, 2)


def _whole_number(value: Any, field: str, minimum: int = 0, maximum: int = MAX_TICKET_QUANTITY) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a whole number.")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a whole number.") from None
    if number < minimum:
        raise ValueError(f"{field} cannot be less than {minimum}.")
    if number > maximum:
        raise ValueError(f"{field} cannot exceed {maximum}.")
    return number


def _normalise_date(value: Any, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    candidate = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(candidate).date().isoformat()
    except ValueError:
        try:
            return datetime.strptime(text, "%Y-%m-%d").date().isoformat()
        except ValueError:
            raise ValueError(f"{field} must use YYYY-MM-DD format.") from None


def _next_code(cursor: sqlite3.Cursor, table: str, column: str, prefix: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    pattern = f"{prefix}-{stamp}-%"
    cursor.execute(
        f"SELECT {column} FROM {table} WHERE {column} LIKE ? ORDER BY {column} DESC LIMIT 1",
        (pattern,),
    )
    row = cursor.fetchone()
    next_number = 1
    if row and row[0]:
        try:
            next_number = int(str(row[0]).split("-")[-1]) + 1
        except ValueError:
            next_number = 1
    return f"{prefix}-{stamp}-{next_number:05d}"


def init_db() -> None:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS fare_settings (
                route TEXT PRIMARY KEY,
                full_fare REAL NOT NULL DEFAULT 120.0,
                half_fare REAL NOT NULL DEFAULT 60.0,
                free_fare REAL NOT NULL DEFAULT 0.0,
                currency TEXT NOT NULL DEFAULT 'INR',
                updated_at TEXT NOT NULL
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS passenger_categories (
                code TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                fare_basis TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS etm_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        cursor.execute(
            "SELECT value FROM etm_metadata WHERE key = 'passenger_category_labels_v1194'"
        )
        labels_migrated = cursor.fetchone() is not None
        for code, label, fare_basis, sort_order in PASSENGER_CATEGORIES:
            legacy_label = LEGACY_CATEGORY_LABELS.get(code)
            if legacy_label and not labels_migrated:
                cursor.execute("""
                    UPDATE passenger_categories
                    SET label = ?
                    WHERE code = ? AND label = ?
                """, (label, code, legacy_label))
            cursor.execute("""
                INSERT INTO passenger_categories (code, label, fare_basis, sort_order, active)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(code) DO NOTHING
            """, (code, label, fare_basis, sort_order))
        cursor.execute("""
            INSERT INTO etm_metadata (key, value)
            VALUES ('passenger_category_labels_v1194', 'applied')
            ON CONFLICT(key) DO NOTHING
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_number TEXT NOT NULL UNIQUE,
                bus_id TEXT NOT NULL,
                route TEXT NOT NULL,
                trip_id TEXT NOT NULL,
                bus_trip_id INTEGER,
                conductor_id TEXT DEFAULT '',
                boarding_stop TEXT DEFAULT '',
                destination_stop TEXT DEFAULT '',
                full_count INTEGER NOT NULL DEFAULT 0,
                half_count INTEGER NOT NULL DEFAULT 0,
                free_count INTEGER NOT NULL DEFAULT 0,
                total_passengers INTEGER NOT NULL,
                full_fare REAL NOT NULL DEFAULT 0.0,
                half_fare REAL NOT NULL DEFAULT 0.0,
                free_fare REAL NOT NULL DEFAULT 0.0,
                total_fare REAL NOT NULL DEFAULT 0.0,
                currency TEXT NOT NULL DEFAULT 'INR',
                client_request_id TEXT DEFAULT '',
                request_fingerprint TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Valid',
                issued_at TEXT NOT NULL,
                cancelled_at TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ticket_passenger_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                category_code TEXT NOT NULL,
                category_label TEXT DEFAULT '',
                fare_basis TEXT DEFAULT '',
                passenger_count INTEGER NOT NULL,
                unit_fare REAL NOT NULL DEFAULT 0.0,
                line_total REAL NOT NULL DEFAULT 0.0,
                created_at TEXT NOT NULL,
                UNIQUE(ticket_id, category_code)
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS pass_registrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pass_number TEXT NOT NULL UNIQUE,
                acknowledgement_id TEXT NOT NULL DEFAULT '',
                bus_id TEXT NOT NULL,
                route TEXT NOT NULL,
                trip_id TEXT NOT NULL,
                bus_trip_id INTEGER,
                conductor_id TEXT DEFAULT '',
                pass_type TEXT NOT NULL DEFAULT 'Monthly Pass',
                passenger_count INTEGER NOT NULL DEFAULT 1,
                valid_from TEXT NOT NULL DEFAULT '',
                valid_until TEXT NOT NULL DEFAULT '',
                boarding_stop TEXT NOT NULL DEFAULT '',
                destination_stop TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Valid',
                notes TEXT DEFAULT '',
                cancelled_at TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        conductor_db.ensure_columns(cursor, "tickets", [
            ("bus_trip_id", "INTEGER"),
            ("boarding_stop", "TEXT DEFAULT ''"),
            ("destination_stop", "TEXT DEFAULT ''"),
            ("client_request_id", "TEXT DEFAULT ''"),
            ("request_fingerprint", "TEXT DEFAULT ''"),
        ])
        conductor_db.ensure_columns(cursor, "ticket_passenger_categories", [
            ("category_label", "TEXT DEFAULT ''"),
            ("fare_basis", "TEXT DEFAULT ''"),
        ])
        conductor_db.ensure_columns(cursor, "pass_registrations", [
            ("bus_trip_id", "INTEGER"),
            ("acknowledgement_id", "TEXT NOT NULL DEFAULT ''"),
            ("boarding_stop", "TEXT NOT NULL DEFAULT ''"),
            ("destination_stop", "TEXT NOT NULL DEFAULT ''"),
        ])
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tickets_bus_trip ON tickets(bus_id, trip_id, issued_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tickets_trip_link ON tickets(bus_trip_id, issued_at DESC)")
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_client_request
            ON tickets(client_request_id)
            WHERE client_request_id IS NOT NULL AND client_request_id <> ''
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_passes_bus_trip ON pass_registrations(bus_id, trip_id, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_passes_trip_link ON pass_registrations(bus_trip_id, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ticket_category_ticket ON ticket_passenger_categories(ticket_id)")
        cursor.execute("""
            SELECT id FROM pass_registrations
            WHERE acknowledgement_id IS NULL OR acknowledgement_id = ''
            ORDER BY id
        """)
        for pass_row in cursor.fetchall():
            acknowledgement_id = _next_code(
                cursor, "pass_registrations", "acknowledgement_id", "PA"
            )
            cursor.execute(
                "UPDATE pass_registrations SET acknowledgement_id = ? WHERE id = ?",
                (acknowledgement_id, pass_row["id"]),
            )
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_passes_acknowledgement
            ON pass_registrations(acknowledgement_id)
            WHERE acknowledgement_id <> ''
        """)

        cursor.execute("SELECT DISTINCT route FROM registered_buses WHERE route <> ''")
        routes = [row[0] for row in cursor.fetchall()]
        now_iso = _now_iso()
        for route in routes:
            cursor.execute("""
                INSERT INTO fare_settings (route, full_fare, half_fare, free_fare, currency, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(route) DO NOTHING
            """, (route, DEFAULT_FULL_FARE, DEFAULT_HALF_FARE, DEFAULT_FREE_FARE, DEFAULT_CURRENCY, now_iso))
        conn.commit()
    finally:
        conn.close()


def get_fare_settings(route: str) -> Dict[str, Any]:
    route = _clean_text(route, "Route", required=True, max_length=100)
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM fare_settings WHERE route = ?", (route,))
        row = cursor.fetchone()
        if row:
            return {**dict(row), "configured": True}
        return {
            "route": route,
            "full_fare": DEFAULT_FULL_FARE,
            "half_fare": DEFAULT_HALF_FARE,
            "free_fare": DEFAULT_FREE_FARE,
            "currency": DEFAULT_CURRENCY,
            "updated_at": "",
            "configured": False,
        }
    finally:
        conn.close()


def save_fare_settings(
    route: str,
    full_fare: Any,
    half_fare: Any,
    free_fare: Any = DEFAULT_FREE_FARE,
    currency: str = DEFAULT_CURRENCY,
) -> Dict[str, Any]:
    route = _clean_text(route, "Route", required=True, max_length=100)
    full = _number(full_fare, "Full fare")
    half = _number(half_fare, "Half fare")
    free = _number(free_fare, "Free fare")
    currency = (_clean_text(currency, "Currency", max_length=10) or DEFAULT_CURRENCY).upper()
    if full <= 0:
        raise ValueError("Full fare must be greater than zero.")
    if half > full:
        raise ValueError("Half fare cannot exceed the full fare.")
    if free != 0:
        raise ValueError("Free fare must be zero.")

    now_iso = _now_iso()
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO fare_settings (route, full_fare, half_fare, free_fare, currency, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(route) DO UPDATE SET
                full_fare = excluded.full_fare,
                half_fare = excluded.half_fare,
                free_fare = excluded.free_fare,
                currency = excluded.currency,
                updated_at = excluded.updated_at
        """, (route, full, half, free, currency, now_iso))
        conn.commit()
    finally:
        conn.close()
    return get_fare_settings(route)


def _normalise_category_code(value: Any) -> str:
    text = _clean_text(value, "Category code", required=True, max_length=32)
    code = text.upper().replace(" ", "_").replace("-", "_")
    if not CATEGORY_CODE_PATTERN.match(code):
        raise ValueError("Category code may only contain letters, numbers and underscores.")
    return code


def _normalise_fare_basis(value: Any) -> str:
    basis = _clean_text(value, "Fare basis", required=True, max_length=10).lower()
    if basis not in FARE_BASES:
        raise ValueError("Fare basis must be one of full, half or free.")
    return basis


def _category_row(row: sqlite3.Row) -> Dict[str, Any]:
    category = dict(row)
    category["active"] = bool(category.get("active"))
    return category


def get_passenger_categories(include_inactive: bool = False) -> List[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM passenger_categories"
        if not include_inactive:
            query += " WHERE active = 1"
        query += " ORDER BY sort_order ASC, code ASC"
        cursor.execute(query)
        return [_category_row(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def save_passenger_category(
    code: Any,
    label: Any,
    fare_basis: Any = "full",
    sort_order: Any = None,
    active: bool = True,
) -> Dict[str, Any]:
    category_code = _normalise_category_code(code)
    category_label = _clean_text(label, "Category label", required=True, max_length=80)
    basis = _normalise_fare_basis(fare_basis)
    is_active = bool(active)

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        if sort_order is None:
            cursor.execute(
                "SELECT sort_order FROM passenger_categories WHERE code = ?",
                (category_code,),
            )
            existing_order = cursor.fetchone()
            if existing_order:
                order = int(existing_order[0])
            else:
                cursor.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM passenger_categories")
                order = int(cursor.fetchone()[0] or 1)
        else:
            order = _whole_number(sort_order, "Category sort order", minimum=0, maximum=9999)

        if not is_active:
            cursor.execute(
                "SELECT COUNT(*) FROM passenger_categories WHERE active = 1 AND code != ?",
                (category_code,),
            )
            if int(cursor.fetchone()[0] or 0) == 0:
                raise ValueError("At least one passenger category must remain active.")

        cursor.execute("""
            INSERT INTO passenger_categories (code, label, fare_basis, sort_order, active)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                label = excluded.label,
                fare_basis = excluded.fare_basis,
                sort_order = excluded.sort_order,
                active = excluded.active
        """, (category_code, category_label, basis, order, 1 if is_active else 0))
        conn.commit()
        cursor.execute("SELECT * FROM passenger_categories WHERE code = ?", (category_code,))
        return _category_row(cursor.fetchone())
    finally:
        conn.close()


def _ticket_row(row: sqlite3.Row) -> Dict[str, Any]:
    ticket = dict(row)
    ticket.pop("request_fingerprint", None)
    return ticket


def _normalise_request_id(value: Any) -> str:
    return _clean_text(value, "Client request ID", max_length=128)


def _ticket_request_fingerprint(
    bus_id: str,
    route: str,
    trip_id: str,
    conductor_id: str,
    categories: List[Dict[str, Any]],
    boarding_stop: str,
    destination_stop: str,
) -> str:
    payload = {
        "bus_id": bus_id,
        "route": route,
        "trip_id": trip_id,
        "conductor_id": conductor_id,
        "categories": [
            {"code": item["category_code"], "quantity": item["quantity"]}
            for item in categories
        ],
        "boarding_stop": boarding_stop,
        "destination_stop": destination_stop,
    }
    serialised = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialised.encode("utf-8")).hexdigest()


def _resolve_ticket_categories(
    items: Optional[List[Dict[str, Any]]],
    full: int,
    half: int,
    free: int,
) -> List[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM passenger_categories")
        categories = {row["code"]: dict(row) for row in cursor.fetchall()}
    finally:
        conn.close()

    resolved: List[Dict[str, Any]] = []
    if items:
        seen = set()
        for index, item in enumerate(items, start=1):
            if hasattr(item, "model_dump"):
                item = item.model_dump()
            if not isinstance(item, dict):
                raise ValueError(f"Ticket item {index} must be an object.")
            code = _normalise_category_code(
                item.get("category_code") or item.get("code")
            )
            if code in seen:
                raise ValueError(f"Passenger category {code} was specified more than once.")
            seen.add(code)
            category = categories.get(code)
            if not category or not category.get("active"):
                raise ValueError(f"Passenger category {code} is not active.")
            quantity = _whole_number(
                item.get("quantity", 0), f"Quantity for {category['label']}"
            )
            if quantity <= 0:
                continue
            resolved.append({
                "category_code": code,
                "category_label": category["label"],
                "fare_basis": category["fare_basis"],
                "quantity": quantity,
            })
    else:
        for code, quantity, default_label, default_basis in (
            ("FULL", full, "Full fare passenger", "full"),
            ("HALF", half, "Half fare passenger", "half"),
            ("FREE", free, "Free fare passenger", "free"),
        ):
            if quantity <= 0:
                continue
            category = categories.get(code, {})
            resolved.append({
                "category_code": code,
                "category_label": category.get("label") or default_label,
                "fare_basis": category.get("fare_basis") or default_basis,
                "quantity": quantity,
            })

    if not resolved:
        raise ValueError("At least one passenger is required to issue a ticket.")
    return resolved


def _get_request_ticket_row(request_id: str) -> Optional[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM tickets WHERE client_request_id = ? LIMIT 1",
            (request_id,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_ticket_category_breakdown(ticket_id: int) -> List[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT category_code, category_label, fare_basis,
                   passenger_count, unit_fare, line_total
            FROM ticket_passenger_categories
            WHERE ticket_id = ? ORDER BY category_code
        """, (ticket_id,))
        breakdown = []
        for row in cursor.fetchall():
            item = dict(row)
            item["category_label"] = item.get("category_label") or item["category_code"].title()
            item["fare_basis"] = item.get("fare_basis") or item["category_code"].lower()
            breakdown.append(item)
        return breakdown
    finally:
        conn.close()


def get_ticket_by_id(ticket_id: int) -> Optional[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,))
        row = cursor.fetchone()
        if not row:
            return None
        ticket = _ticket_row(row)
        ticket["passenger_categories"] = get_ticket_category_breakdown(ticket_id)
        return ticket
    finally:
        conn.close()


def issue_ticket(
    bus_id: str,
    route: str,
    trip_id: str,
    conductor_id: str = "",
    full_count: int = 0,
    half_count: int = 0,
    free_count: int = 0,
    client_request_id: str = "",
    items: Optional[List[Dict[str, Any]]] = None,
    boarding_stop: str = "",
    destination_stop: str = "",
) -> Dict[str, Any]:
    bus_id = _clean_text(bus_id, "Bus registration number", required=True, max_length=50)
    route = _clean_text(route, "Route", required=True, max_length=100)
    trip_id = _clean_text(trip_id, "Trip identifier", required=True, max_length=50)
    conductor_id = _clean_text(conductor_id, "Conductor", max_length=100)
    boarding = _clean_text(boarding_stop, "Boarding stop", max_length=100)
    destination = _clean_text(destination_stop, "Destination stop", max_length=100)
    request_id = _normalise_request_id(client_request_id)
    full = _whole_number(full_count, "Full fare passengers")
    half = _whole_number(half_count, "Half fare passengers")
    free = _whole_number(free_count, "Free fare passengers")
    category_items = _resolve_ticket_categories(items, full, half, free)

    total_passengers = sum(int(item["quantity"]) for item in category_items)
    full = sum(int(item["quantity"]) for item in category_items if item["fare_basis"] == "full")
    half = sum(int(item["quantity"]) for item in category_items if item["fare_basis"] == "half")
    free = sum(int(item["quantity"]) for item in category_items if item["fare_basis"] == "free")
    fingerprint = _ticket_request_fingerprint(
        bus_id, route, trip_id, conductor_id, category_items, boarding, destination
    )

    if request_id:
        existing = _get_request_ticket_row(request_id)
        if existing:
            if existing.get("request_fingerprint") != fingerprint:
                raise IdempotencyConflictError(
                    "Client request ID was already used for a different ticket."
                )
            ticket = get_ticket_by_id(existing["id"]) or {}
            ticket["duplicate"] = True
            return ticket

    trip = conductor_db.ensure_active_bus_trip(bus_id, route, trip_id, conductor_id)
    bus_trip_id = trip["id"]

    fares = get_fare_settings(route)
    unit_fares = {
        "full": float(fares["full_fare"]),
        "half": float(fares["half_fare"]),
        "free": float(fares["free_fare"]),
    }
    full_fare = unit_fares["full"]
    half_fare = unit_fares["half"]
    free_fare = unit_fares["free"]
    currency = fares["currency"]
    total_fare = round(
        full * full_fare + half * half_fare + free * free_fare, 2
    )
    now_iso = _now_iso()

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        last_error: Optional[Exception] = None
        for _ in range(3):
            ticket_number = _next_code(cursor, "tickets", "ticket_number", "ST")
            try:
                cursor.execute("""
                    INSERT INTO tickets (
                        ticket_number, bus_id, route, trip_id, bus_trip_id, conductor_id,
                        boarding_stop, destination_stop,
                        full_count, half_count, free_count, total_passengers,
                        full_fare, half_fare, free_fare, total_fare, currency,
                        client_request_id, request_fingerprint,
                        status, issued_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Valid', ?, ?)
                """, (
                    ticket_number, bus_id, route, trip_id, bus_trip_id, conductor_id,
                    boarding, destination,
                    full, half, free, total_passengers,
                    full_fare, half_fare, free_fare, total_fare, currency,
                    request_id, fingerprint, now_iso, now_iso,
                ))
                ticket_id = cursor.lastrowid
                for item in category_items:
                    count = int(item["quantity"])
                    unit_fare = unit_fares[item["fare_basis"]]
                    cursor.execute("""
                        INSERT INTO ticket_passenger_categories
                        (ticket_id, category_code, category_label, fare_basis,
                         passenger_count, unit_fare, line_total, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        ticket_id, item["category_code"], item["category_label"],
                        item["fare_basis"], count, unit_fare,
                        round(count * unit_fare, 2), now_iso,
                    ))
                conn.commit()
                return get_ticket_by_id(ticket_id) or {}
            except sqlite3.IntegrityError as exc:
                conn.rollback()
                if request_id:
                    existing = _get_request_ticket_row(request_id)
                    if existing:
                        if existing.get("request_fingerprint") != fingerprint:
                            raise IdempotencyConflictError(
                                "Client request ID was already used for a different ticket."
                            ) from exc
                        ticket = get_ticket_by_id(existing["id"]) or {}
                        ticket["duplicate"] = True
                        return ticket
                last_error = exc
        raise ValueError("Could not generate a unique ticket number; please retry.") from last_error
    finally:
        conn.close()


def list_tickets(
    bus_id: Optional[str] = None,
    trip_id: Optional[str] = None,
    route: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM tickets"
        conditions: List[str] = []
        params: List[Any] = []
        if bus_id and bus_id.strip():
            conditions.append("bus_id = ?")
            params.append(bus_id.strip())
        if trip_id and trip_id.strip():
            conditions.append("trip_id = ?")
            params.append(trip_id.strip())
        if route and route.strip():
            conditions.append("route = ?")
            params.append(route.strip())
        if status and status.strip():
            status = status.strip().title()
            if status not in TICKET_STATUSES:
                raise ValueError(
                    f"Status must be one of: {', '.join(sorted(TICKET_STATUSES))}."
                )
            conditions.append("status = ?")
            params.append(status)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY issued_at DESC, id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        cursor.execute(query, tuple(params))
        return [_ticket_row(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def cancel_ticket(ticket_id: int) -> Optional[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,))
        ticket = cursor.fetchone()
        if not ticket:
            return None
        if ticket["status"] != "Valid":
            raise ValueError("Only valid tickets can be cancelled.")
        cursor.execute(
            "UPDATE tickets SET status = 'Cancelled', cancelled_at = ? WHERE id = ? AND status = 'Valid'",
            (_now_iso(), ticket_id),
        )
        if cursor.rowcount == 0:
            raise ValueError("Only valid tickets can be cancelled.")
        conn.commit()
    finally:
        conn.close()
    return get_ticket_by_id(ticket_id)


def _pass_with_validity(row: Any) -> Dict[str, Any]:
    passenger_pass = dict(row)
    today = _utc_today()
    pass_status = passenger_pass.get("status") or ""
    valid_from = str(passenger_pass.get("valid_from") or "")
    valid_until = str(passenger_pass.get("valid_until") or "")
    if pass_status != "Valid":
        validity_status = pass_status or "Unknown"
    elif valid_from and valid_from > today:
        validity_status = "Scheduled"
    elif valid_until and valid_until < today:
        validity_status = "Expired"
    else:
        validity_status = "Valid"
    passenger_pass["validity_status"] = validity_status
    passenger_pass["valid_now"] = validity_status == "Valid"
    return passenger_pass


def get_pass_by_id(pass_id: int) -> Optional[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pass_registrations WHERE id = ?", (pass_id,))
        row = cursor.fetchone()
        return _pass_with_validity(row) if row else None
    finally:
        conn.close()


def register_pass(
    bus_id: str,
    route: str,
    trip_id: str,
    conductor_id: str = "",
    pass_number: str = "",
    pass_type: str = "Monthly Pass",
    passenger_count: int = 1,
    valid_from: str = "",
    valid_until: str = "",
    boarding_stop: str = "",
    destination_stop: str = "",
    notes: str = "",
) -> Dict[str, Any]:
    bus_id = _clean_text(bus_id, "Bus registration number", required=True, max_length=50)
    route = _clean_text(route, "Route", required=True, max_length=100)
    trip_id = _clean_text(trip_id, "Trip identifier", required=True, max_length=50)
    conductor_id = _clean_text(conductor_id, "Conductor", max_length=100)
    pass_number = _clean_text(pass_number, "Pass ID", max_length=60).upper()
    if pass_number and not PASS_NUMBER_PATTERN.match(pass_number):
        raise ValueError(
            "Pass ID may contain letters, numbers, spaces, dots, slashes, underscores and hyphens."
        )
    pass_type = _clean_text(pass_type, "Pass type", required=True, max_length=60)
    boarding_stop = _clean_text(boarding_stop, "Boarding stop", max_length=100)
    destination_stop = _clean_text(destination_stop, "Destination stop", max_length=100)
    if bool(boarding_stop) != bool(destination_stop):
        raise ValueError("Boarding and destination stops must be provided together.")
    if boarding_stop and boarding_stop.casefold() == destination_stop.casefold():
        raise ValueError("Destination stop must be different from the boarding stop.")
    notes = _clean_text(notes, "Remarks", max_length=500)
    count = _whole_number(passenger_count, "Pass passengers", minimum=1, maximum=MAX_PASSENGERS_PER_PASS)
    from_date = _normalise_date(valid_from, "Valid from") or _utc_today()
    until_date = _normalise_date(valid_until, "Valid until")
    if until_date and until_date < from_date:
        raise ValueError("Valid until cannot be earlier than valid from.")

    trip = conductor_db.ensure_active_bus_trip(bus_id, route, trip_id, conductor_id)
    bus_trip_id = trip["id"]

    now_iso = _now_iso()
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        if pass_number:
            cursor.execute(
                "SELECT 1 FROM pass_registrations WHERE pass_number = ? LIMIT 1",
                (pass_number,),
            )
            if cursor.fetchone():
                raise ValueError("Pass ID already exists.")
        last_error: Optional[Exception] = None
        for _ in range(3):
            number = pass_number or _next_code(
                cursor, "pass_registrations", "pass_number", "PS"
            )
            acknowledgement_id = _next_code(
                cursor, "pass_registrations", "acknowledgement_id", "PA"
            )
            try:
                cursor.execute("""
                    INSERT INTO pass_registrations (
                        pass_number, acknowledgement_id, bus_id, route, trip_id,
                        bus_trip_id, conductor_id, pass_type, passenger_count,
                        valid_from, valid_until, boarding_stop, destination_stop,
                        status, notes, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Valid', ?, ?)
                """, (
                    number, acknowledgement_id, bus_id, route, trip_id,
                    bus_trip_id, conductor_id, pass_type, count,
                    from_date, until_date, boarding_stop, destination_stop,
                    notes, now_iso,
                ))
                conn.commit()
                return get_pass_by_id(cursor.lastrowid) or {}
            except sqlite3.IntegrityError as exc:
                conn.rollback()
                last_error = exc
                if pass_number:
                    raise ValueError("Pass ID already exists.") from exc
        raise ValueError("Could not generate a unique pass registration; please retry.") from last_error
    finally:
        conn.close()


def list_passes(
    bus_id: Optional[str] = None,
    trip_id: Optional[str] = None,
    route: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM pass_registrations"
        conditions: List[str] = []
        params: List[Any] = []
        if bus_id and bus_id.strip():
            conditions.append("bus_id = ?")
            params.append(bus_id.strip())
        if trip_id and trip_id.strip():
            conditions.append("trip_id = ?")
            params.append(trip_id.strip())
        if route and route.strip():
            conditions.append("route = ?")
            params.append(route.strip())
        if status and status.strip():
            conditions.append("status = ?")
            params.append(status.strip())
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY created_at DESC, id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        cursor.execute(query, tuple(params))
        return [_pass_with_validity(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def cancel_pass(pass_id: int) -> Optional[Dict[str, Any]]:
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM pass_registrations WHERE id = ?", (pass_id,))
        if not cursor.fetchone():
            return None
        cursor.execute(
            "UPDATE pass_registrations SET status = 'Cancelled', cancelled_at = ? WHERE id = ?",
            (_now_iso(), pass_id),
        )
        conn.commit()
    finally:
        conn.close()
    return get_pass_by_id(pass_id)


def _empty_summary(bus_id: str, trip_id: str, route: str) -> Dict[str, Any]:
    fallback_fares = {
        "route": route,
        "full_fare": DEFAULT_FULL_FARE,
        "half_fare": DEFAULT_HALF_FARE,
        "free_fare": DEFAULT_FREE_FARE,
        "currency": DEFAULT_CURRENCY,
        "configured": False,
    }
    if route:
        try:
            fares = get_fare_settings(route)
        except sqlite3.OperationalError:
            fares = fallback_fares
    else:
        fares = fallback_fares
    return {
        "bus_id": bus_id,
        "trip_id": trip_id,
        "route": route,
        "ticket_count": 0,
        "full_fare_passengers": 0,
        "half_fare_passengers": 0,
        "free_fare_passengers": 0,
        "ticket_passengers": 0,
        "ticket_revenue": 0.0,
        "pass_count": 0,
        "pass_passengers": 0,
        "expected_passengers": 0,
        "last_ticket_at": "",
        "last_pass_at": "",
        "last_updated_at": "",
        "currency": fares["currency"],
        "fares": fares,
    }


def get_ticketing_summary(bus_id: str, trip_id: str, route: str = "") -> Dict[str, Any]:
    bus_id = _clean_text(bus_id, "Bus registration number", max_length=50)
    trip_id = _clean_text(trip_id, "Trip identifier", max_length=50)
    route = _clean_text(route, "Route", max_length=100)
    if not bus_id or not trip_id:
        return _empty_summary(bus_id, trip_id, route)

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                COUNT(*) AS ticket_count,
                COALESCE(SUM(full_count), 0) AS full_fare_passengers,
                COALESCE(SUM(half_count), 0) AS half_fare_passengers,
                COALESCE(SUM(free_count), 0) AS free_fare_passengers,
                COALESCE(SUM(total_passengers), 0) AS ticket_passengers,
                COALESCE(SUM(total_fare), 0) AS ticket_revenue,
                COALESCE(MAX(issued_at), '') AS last_ticket_at
            FROM tickets
            WHERE bus_id = ? AND trip_id = ? AND status = 'Valid'
        """, (bus_id, trip_id))
        ticket = dict(cursor.fetchone())

        today = _utc_today()
        cursor.execute("""
            SELECT
                COUNT(*) AS pass_count,
                COALESCE(SUM(passenger_count), 0) AS pass_passengers,
                COALESCE(MAX(created_at), '') AS last_pass_at
            FROM pass_registrations
            WHERE bus_id = ? AND trip_id = ? AND status = 'Valid'
              AND (valid_from = '' OR date(valid_from) <= date(?))
              AND (valid_until = '' OR date(valid_until) >= date(?))
        """, (bus_id, trip_id, today, today))
        passes = dict(cursor.fetchone())

        summary = _empty_summary(bus_id, trip_id, route)
        summary.update({
            "ticket_count": int(ticket.get("ticket_count") or 0),
            "full_fare_passengers": int(ticket.get("full_fare_passengers") or 0),
            "half_fare_passengers": int(ticket.get("half_fare_passengers") or 0),
            "free_fare_passengers": int(ticket.get("free_fare_passengers") or 0),
            "ticket_passengers": int(ticket.get("ticket_passengers") or 0),
            "ticket_revenue": round(float(ticket.get("ticket_revenue") or 0.0), 2),
            "pass_count": int(passes.get("pass_count") or 0),
            "pass_passengers": int(passes.get("pass_passengers") or 0),
            "last_ticket_at": ticket.get("last_ticket_at") or "",
            "last_pass_at": passes.get("last_pass_at") or "",
        })
        summary["expected_passengers"] = summary["ticket_passengers"] + summary["pass_passengers"]
        summary["last_updated_at"] = max(
            summary["last_ticket_at"], summary["last_pass_at"]
        )
        return summary
    except sqlite3.OperationalError:
        return _empty_summary(bus_id, trip_id, route)
    finally:
        conn.close()


def _mismatch_tolerance(tolerance: Optional[int] = None) -> int:
    if tolerance is not None:
        try:
            return max(0, int(tolerance))
        except (TypeError, ValueError):
            return DEFAULT_MISMATCH_TOLERANCE
    raw = os.environ.get("MISMATCH_TOLERANCE", os.environ.get("MISMATCH_THRESHOLD", ""))
    if not str(raw).strip():
        return DEFAULT_MISMATCH_TOLERANCE
    try:
        return max(0, int(float(str(raw).strip())))
    except (TypeError, ValueError):
        return DEFAULT_MISMATCH_TOLERANCE


def get_active_trip_comparisons(
    model_available: bool = True,
    tolerance: Optional[int] = None,
) -> Dict[str, Any]:
    """Compares active-trip ETM totals with the latest trustworthy camera count."""
    limit = _mismatch_tolerance(tolerance)
    trips = conductor_db.list_bus_trips(status="Active", limit=500)
    rows: List[Dict[str, Any]] = []
    for trip in trips:
        bus_id = str(trip.get("bus_id") or "")
        trip_id = str(trip.get("trip_id") or "")
        route = str(trip.get("route") or "")
        summary = get_ticketing_summary(bus_id, trip_id, route)
        camera = conductor_db.get_camera_state(bus_id, model_available=model_available)
        camera_status = str(camera.get("status") or "unavailable")
        detected = camera.get("count") if camera_status == "connected" else None
        detected = int(detected) if detected is not None else None
        expected = int(summary.get("expected_passengers") or 0)
        difference = detected - expected if detected is not None else None
        difference_abs = abs(difference) if difference is not None else None

        if camera_status == "stale":
            status = "Stale"
        elif camera_status != "connected":
            status = "Camera unavailable"
        elif difference == 0:
            status = "Match"
        elif difference_abs is not None and difference_abs <= limit:
            status = "Within tolerance"
        else:
            status = "Mismatch"

        rows.append({
            "trip_record_id": trip.get("id"),
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "started_at": trip.get("started_at"),
            "expected_passengers": expected,
            "detected_passengers": detected,
            "difference": difference,
            "difference_abs": difference_abs,
            "tolerance": limit,
            "status": status,
            "within_tolerance": difference is not None and difference_abs is not None and difference_abs <= limit,
            "is_mismatch": status == "Mismatch",
            "ticket_count": summary.get("ticket_count", 0),
            "ticket_passengers": summary.get("ticket_passengers", 0),
            "pass_count": summary.get("pass_count", 0),
            "pass_passengers": summary.get("pass_passengers", 0),
            "full_fare_passengers": summary.get("full_fare_passengers", 0),
            "half_fare_passengers": summary.get("half_fare_passengers", 0),
            "free_fare_passengers": summary.get("free_fare_passengers", 0),
            "ticket_revenue": summary.get("ticket_revenue", 0.0),
            "currency": summary.get("currency", DEFAULT_CURRENCY),
            "expected_updated_at": summary.get("last_updated_at", ""),
            "camera_status": camera_status,
            "camera_updated_at": camera.get("updated_at"),
            "camera_age_seconds": camera.get("age_seconds"),
            "camera_message": camera.get("message", ""),
            "stale_after_seconds": camera.get("stale_after_seconds"),
        })

    return {
        "comparisons": rows,
        "count": len(rows),
        "tolerance": limit,
    }


def _range_start(days: int) -> str:
    days = max(1, min(int(days), 365))
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def get_passenger_analytics(days: int = 7, route: Optional[str] = None) -> Dict[str, Any]:
    try:
        days = max(1, min(int(days), 365))
    except (TypeError, ValueError):
        days = 7
    route_filter = _clean_text(route, "Route", max_length=100)
    cutoff = _range_start(days)

    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        ticket_where = "created_at >= ?"
        ticket_params: List[Any] = [cutoff]
        if route_filter:
            ticket_where += " AND route = ?"
            ticket_params.append(route_filter)

        cursor.execute(f"""
            SELECT
                COUNT(*) AS ticket_count,
                COALESCE(SUM(full_count), 0) AS full_fare_passengers,
                COALESCE(SUM(half_count), 0) AS half_fare_passengers,
                COALESCE(SUM(free_count), 0) AS free_fare_passengers,
                COALESCE(SUM(total_passengers), 0) AS ticket_passengers,
                COALESCE(SUM(total_fare), 0) AS revenue
            FROM tickets
            WHERE {ticket_where} AND status = 'Valid'
        """, tuple(ticket_params))
        ticket = dict(cursor.fetchone())

        pass_where = "created_at >= ?"
        pass_params: List[Any] = [cutoff]
        if route_filter:
            pass_where += " AND route = ?"
            pass_params.append(route_filter)
        cursor.execute(f"""
            SELECT
                COUNT(*) AS pass_count,
                COALESCE(SUM(passenger_count), 0) AS pass_passengers
            FROM pass_registrations
            WHERE {pass_where} AND status = 'Valid'
              AND (valid_from = '' OR date(valid_from) <= date('now'))
              AND (valid_until = '' OR date(valid_until) >= date('now'))
        """, tuple(pass_params))
        pass_stats = dict(cursor.fetchone())

        checkpoint_where = "created_at >= ?"
        checkpoint_params: List[Any] = [cutoff]
        if route_filter:
            checkpoint_where += " AND route = ?"
            checkpoint_params.append(route_filter)
        cursor.execute(f"""
            SELECT
                COUNT(*) AS checkpoint_count,
                COALESCE(SUM(CASE WHEN difference_abs > 0 THEN 1 ELSE 0 END), 0) AS mismatch_checkpoints,
                COALESCE(AVG(ABS(difference)), 0) AS average_variance,
                COALESCE(MAX(difference_abs), 0) AS maximum_variance
            FROM checkpoint_submissions
            WHERE {checkpoint_where} AND difference_abs IS NOT NULL
        """, tuple(checkpoint_params))
        checkpoints = dict(cursor.fetchone())

        alert_where = "created_at >= ?"
        alert_params: List[Any] = [cutoff]
        if route_filter:
            alert_where += " AND route = ?"
            alert_params.append(route_filter)
        cursor.execute(f"""
            SELECT
                COUNT(*) AS alert_count,
                COALESCE(SUM(CASE WHEN severity = 'High' THEN 1 ELSE 0 END), 0) AS high_alerts,
                COALESCE(SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END), 0) AS resolved_alerts,
                COALESCE(SUM(CASE WHEN status <> 'Resolved' THEN 1 ELSE 0 END), 0) AS open_alerts
            FROM mismatch_alerts
            WHERE {alert_where}
        """, tuple(alert_params))
        alerts = dict(cursor.fetchone())

        dispatch_where = "created_at >= ?"
        dispatch_params: List[Any] = [cutoff]
        if route_filter:
            dispatch_where += " AND route = ?"
            dispatch_params.append(route_filter)
        cursor.execute(f"""
            SELECT
                COUNT(*) AS dispatch_count,
                COALESCE(SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END), 0) AS completed_inspections
            FROM checker_dispatches
            WHERE {dispatch_where}
        """, tuple(dispatch_params))
        dispatches = dict(cursor.fetchone())

        route_filter_sql = " AND route = ?" if route_filter else ""
        route_filter_params: List[Any] = [route_filter] if route_filter else []

        cursor.execute(f"""
            SELECT route,
                   COALESCE(SUM(ticket_passengers), 0) AS ticket_passengers,
                   COALESCE(SUM(revenue), 0) AS revenue,
                   COALESCE(SUM(ticket_count), 0) AS ticket_count
            FROM (
                SELECT route, total_passengers AS ticket_passengers, total_fare AS revenue, 1 AS ticket_count
                FROM tickets
                WHERE created_at >= ? AND status = 'Valid'{route_filter_sql}
            ) GROUP BY route ORDER BY ticket_passengers DESC
        """, tuple([cutoff] + route_filter_params))
        route_tickets = {row["route"]: dict(row) for row in cursor.fetchall()}

        cursor.execute(f"""
            SELECT route, COALESCE(SUM(passenger_count), 0) AS pass_passengers, COUNT(*) AS pass_count
            FROM pass_registrations
            WHERE created_at >= ? AND status = 'Valid'{route_filter_sql}
              AND (valid_from = '' OR date(valid_from) <= date('now'))
              AND (valid_until = '' OR date(valid_until) >= date('now'))
            GROUP BY route
        """, tuple([cutoff] + route_filter_params))
        route_passes = {row["route"]: dict(row) for row in cursor.fetchall()}

        cursor.execute(f"""
            SELECT route, COUNT(*) AS checkpoint_count,
                   COALESCE(SUM(CASE WHEN difference_abs > 0 THEN 1 ELSE 0 END), 0) AS mismatches
            FROM checkpoint_submissions
            WHERE created_at >= ? AND difference_abs IS NOT NULL{route_filter_sql}
            GROUP BY route
        """, tuple([cutoff] + route_filter_params))
        route_checkpoints = {row["route"]: dict(row) for row in cursor.fetchall()}

        cursor.execute(f"""
            SELECT route, COUNT(*) AS alerts,
                   COALESCE(SUM(CASE WHEN severity = 'High' THEN 1 ELSE 0 END), 0) AS high_alerts
            FROM mismatch_alerts
            WHERE created_at >= ?{route_filter_sql}
            GROUP BY route
        """, tuple([cutoff] + route_filter_params))
        route_alerts = {row["route"]: dict(row) for row in cursor.fetchall()}

        cursor.execute(f"""
            SELECT route, COUNT(*) AS dispatch_count,
                   COALESCE(SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END), 0) AS completed_inspections
            FROM checker_dispatches
            WHERE created_at >= ?{route_filter_sql}
            GROUP BY route
        """, tuple([cutoff] + route_filter_params))
        route_dispatches = {row["route"]: dict(row) for row in cursor.fetchall()}

        cursor.execute(f"""
            SELECT bus_id, COALESCE(SUM(total_passengers), 0) AS ticket_passengers,
                   COALESCE(SUM(total_fare), 0) AS revenue, COUNT(*) AS ticket_count
            FROM tickets
            WHERE created_at >= ? AND status = 'Valid'{route_filter_sql}
            GROUP BY bus_id
        """, tuple([cutoff] + route_filter_params))
        bus_tickets = {row["bus_id"]: dict(row) for row in cursor.fetchall()}

        cursor.execute(f"""
            SELECT bus_id, COALESCE(SUM(passenger_count), 0) AS pass_passengers, COUNT(*) AS pass_count
            FROM pass_registrations
            WHERE created_at >= ? AND status = 'Valid'{route_filter_sql}
              AND (valid_from = '' OR date(valid_from) <= date('now'))
              AND (valid_until = '' OR date(valid_until) >= date('now'))
            GROUP BY bus_id
        """, tuple([cutoff] + route_filter_params))
        bus_passes = {row["bus_id"]: dict(row) for row in cursor.fetchall()}

        routes = sorted(set(route_tickets) | set(route_passes) | set(route_checkpoints) | set(route_alerts) | set(route_dispatches))
        route_breakdown = []
        for route_name in routes:
            t = route_tickets.get(route_name, {})
            p = route_passes.get(route_name, {})
            c = route_checkpoints.get(route_name, {})
            a = route_alerts.get(route_name, {})
            d = route_dispatches.get(route_name, {})
            route_breakdown.append({
                "route": route_name,
                "ticket_passengers": int(t.get("ticket_passengers") or 0),
                "ticket_count": int(t.get("ticket_count") or 0),
                "revenue": round(float(t.get("revenue") or 0.0), 2),
                "pass_passengers": int(p.get("pass_passengers") or 0),
                "pass_count": int(p.get("pass_count") or 0),
                "checkpoint_count": int(c.get("checkpoint_count") or 0),
                "mismatches": int(c.get("mismatches") or 0),
                "alerts": int(a.get("alerts") or 0),
                "high_alerts": int(a.get("high_alerts") or 0),
                "dispatch_count": int(d.get("dispatch_count") or 0),
                "completed_inspections": int(d.get("completed_inspections") or 0),
            })

        checkpoint_filter_sql = " AND route = ?" if route_filter else ""
        cursor.execute(f"""
            SELECT bus_id, route, active_tickets, valid_passes, reported_passengers,
                   camera_estimate, difference_abs, comparison_status, created_at
            FROM checkpoint_submissions
            WHERE id IN (
                SELECT MAX(id) FROM checkpoint_submissions GROUP BY bus_id
            )
          AND created_at >= ?{checkpoint_filter_sql}
        """, tuple([cutoff] + route_filter_params))
        latest_checkpoints = {row["bus_id"]: dict(row) for row in cursor.fetchall()}

        bus_where_sql = " WHERE route = ?" if route_filter else ""
        cursor.execute(
            f"SELECT id, fleet, route, capacity FROM registered_buses{bus_where_sql} ORDER BY id",
            tuple(route_filter_params),
        )
        buses = [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()

    bus_rows = []
    for bus in buses:
        ticket_row = bus_tickets.get(bus["id"], {})
        pass_row = bus_passes.get(bus["id"], {})
        checkpoint = latest_checkpoints.get(bus["id"], {})
        bus_rows.append({
            "bus_id": bus["id"],
            "fleet": bus["fleet"],
            "route": bus["route"],
            "capacity": bus["capacity"],
            "ticket_passengers": int(ticket_row.get("ticket_passengers") or 0),
            "ticket_count": int(ticket_row.get("ticket_count") or 0),
            "revenue": round(float(ticket_row.get("revenue") or 0.0), 2),
            "pass_passengers": int(pass_row.get("pass_passengers") or 0),
            "pass_count": int(pass_row.get("pass_count") or 0),
            "camera_estimate": checkpoint.get("camera_estimate"),
            "difference_abs": checkpoint.get("difference_abs"),
            "last_checkpoint": checkpoint.get("created_at", ""),
        })

    end_date = datetime.now(timezone.utc).date()
    labels = []
    ticket_series = []
    pass_series = []
    alert_series = []
    trend_start = end_date - timedelta(days=6)
    for offset in range(7):
        day = trend_start + timedelta(days=offset)
        labels.append(day.strftime("%d %b"))
        ticket_series.append(0)
        pass_series.append(0)
        alert_series.append(0)

    trend_days = {(trend_start + timedelta(days=i)).isoformat(): i for i in range(7)}
    conn = conductor_db.get_db_connection()
    try:
        cursor = conn.cursor()
        ticket_filter = "created_at >= ? AND status = 'Valid'"
        ticket_filter_params: List[Any] = [trend_start.isoformat()]
        if route_filter:
            ticket_filter += " AND route = ?"
            ticket_filter_params.append(route_filter)
        cursor.execute(f"""
            SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(total_passengers), 0) AS total
            FROM tickets WHERE {ticket_filter} GROUP BY day
        """, tuple(ticket_filter_params))
        for row in cursor.fetchall():
            index = trend_days.get(row["day"])
            if index is not None:
                ticket_series[index] = int(row["total"] or 0)

        pass_filter = (
            "created_at >= ? AND status = 'Valid'"
            " AND (valid_from = '' OR date(valid_from) <= date('now'))"
            " AND (valid_until = '' OR date(valid_until) >= date('now'))"
        )
        pass_filter_params: List[Any] = [trend_start.isoformat()]
        if route_filter:
            pass_filter += " AND route = ?"
            pass_filter_params.append(route_filter)
        cursor.execute(f"""
            SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(passenger_count), 0) AS total
            FROM pass_registrations WHERE {pass_filter} GROUP BY day
        """, tuple(pass_filter_params))
        for row in cursor.fetchall():
            index = trend_days.get(row["day"])
            if index is not None:
                pass_series[index] = int(row["total"] or 0)

        alert_filter = "created_at >= ?"
        alert_filter_params: List[Any] = [trend_start.isoformat()]
        if route_filter:
            alert_filter += " AND route = ?"
            alert_filter_params.append(route_filter)
        cursor.execute(f"""
            SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS total
            FROM mismatch_alerts WHERE {alert_filter} GROUP BY day
        """, tuple(alert_filter_params))
        for row in cursor.fetchall():
            index = trend_days.get(row["day"])
            if index is not None:
                alert_series[index] = int(row["total"] or 0)
    finally:
        conn.close()

    ticket_passengers = int(ticket.get("ticket_passengers") or 0)
    pass_passengers = int(pass_stats.get("pass_passengers") or 0)
    return {
        "days": days,
        "route": route_filter,
        "summary": {
            "ticket_count": int(ticket.get("ticket_count") or 0),
            "ticket_passengers": ticket_passengers,
            "full_fare_passengers": int(ticket.get("full_fare_passengers") or 0),
            "half_fare_passengers": int(ticket.get("half_fare_passengers") or 0),
            "free_fare_passengers": int(ticket.get("free_fare_passengers") or 0),
            "revenue": round(float(ticket.get("revenue") or 0.0), 2),
            "pass_count": int(pass_stats.get("pass_count") or 0),
            "pass_passengers": pass_passengers,
            "expected_passengers": ticket_passengers + pass_passengers,
            "checkpoint_count": int(checkpoints.get("checkpoint_count") or 0),
            "mismatch_checkpoints": int(checkpoints.get("mismatch_checkpoints") or 0),
            "average_variance": round(float(checkpoints.get("average_variance") or 0.0), 1),
            "maximum_variance": int(checkpoints.get("maximum_variance") or 0),
            "alert_count": int(alerts.get("alert_count") or 0),
            "high_alerts": int(alerts.get("high_alerts") or 0),
            "open_alerts": int(alerts.get("open_alerts") or 0),
            "resolved_alerts": int(alerts.get("resolved_alerts") or 0),
            "dispatch_count": int(dispatches.get("dispatch_count") or 0),
            "completed_inspections": int(dispatches.get("completed_inspections") or 0),
        },
        "route_breakdown": route_breakdown,
        "bus_breakdown": bus_rows,
        "trend": {
            "labels": labels,
            "ticket_passengers": ticket_series,
            "pass_passengers": pass_series,
            "alerts": alert_series,
        },
    }
