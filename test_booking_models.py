"""
Focused tests for trip lifecycle, trip-linked ETM data, passenger categories,
expected/CV counts and mismatch linkage.

Run from the project root:
    python -m unittest test_booking_models -v
"""

import os
import shutil
import tempfile
import unittest

from fastapi.testclient import TestClient

from backend import alert_dispatch, conductor_db, etm_db, main


class BookingModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp_dir = tempfile.mkdtemp(prefix="smartst_booking_models_test_")
        conductor_db.DB_PATH = os.path.join(cls.tmp_dir, "booking_models.db")
        conductor_db.init_db()
        alert_dispatch.init_db()
        etm_db.init_db()
        cls._original_model = main.yolo_model
        main.yolo_model = object()
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        main.yolo_model = cls._original_model
        shutil.rmtree(cls.tmp_dir, ignore_errors=True)

    def start_trip(self, trip_id, bus_id="MH-12-QW-4821", route="Pune - Mumbai"):
        return self.client.post("/api/conductor/trips", json={
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "conductor_id": "A. Jadhav",
        })

    def fetch_one(self, query, params):
        conn = conductor_db.get_db_connection()
        try:
            row = conn.execute(query, params).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def test_01_trip_start_is_idempotent_and_listable(self):
        first = self.start_trip("BKG-TRIP-01")
        self.assertEqual(first.status_code, 200)
        trip = first.json()["trip"]
        self.assertEqual(trip["status"], "Active")
        self.assertEqual(trip["bus_id"], "MH-12-QW-4821")
        self.assertEqual(trip["trip_id"], "BKG-TRIP-01")
        self.assertTrue(trip["started_at"])

        again = self.start_trip("BKG-TRIP-01")
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()["trip"]["id"], trip["id"])

        active = self.client.get(
            "/api/conductor/trips/active",
            params={"bus_id": "MH-12-QW-4821"},
        )
        self.assertEqual(active.status_code, 200)
        self.assertEqual(active.json()["trip"]["id"], trip["id"])

        listed = self.client.get(
            "/api/conductor/trips",
            params={"bus_id": "MH-12-QW-4821"},
        )
        self.assertEqual(listed.status_code, 200)
        trip_ids = {row["trip_id"] for row in listed.json()["trips"]}
        self.assertIn("BKG-TRIP-01", trip_ids)

        detail = self.client.get(f"/api/conductor/trips/{trip['id']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["trip"]["id"], trip["id"])
        self.assertIn("summary", detail.json())

    def test_02_ticket_and_pass_store_trip_and_categories(self):
        started = self.start_trip(
            "BKG-ETM-01",
            bus_id="MH-14-BT-1906",
            route="Pune - Nashik",
        )
        self.assertEqual(started.status_code, 200)
        trip_record_id = started.json()["trip"]["id"]

        ticket_response = self.client.post("/api/conductor/tickets", json={
            "bus_id": "MH-14-BT-1906",
            "route": "Pune - Nashik",
            "trip_id": "BKG-ETM-01",
            "conductor_id": "A. Jadhav",
            "full_count": 2,
            "half_count": 1,
            "free_count": 1,
        })
        self.assertEqual(ticket_response.status_code, 201)
        ticket = ticket_response.json()["ticket"]
        self.assertEqual(ticket["bus_trip_id"], trip_record_id)
        self.assertEqual(len(ticket["passenger_categories"]), 3)

        detail = self.client.get(f"/api/conductor/tickets/{ticket['id']}")
        self.assertEqual(detail.status_code, 200)
        categories = {
            row["category_code"]: row
            for row in detail.json()["ticket"]["passenger_categories"]
        }
        self.assertEqual(categories["FULL"]["passenger_count"], 2)
        self.assertEqual(categories["HALF"]["passenger_count"], 1)
        self.assertEqual(categories["FREE"]["passenger_count"], 1)
        self.assertEqual(categories["FULL"]["line_total"], 240.0)

        pass_response = self.client.post("/api/conductor/passes", json={
            "bus_id": "MH-14-BT-1906",
            "route": "Pune - Nashik",
            "trip_id": "BKG-ETM-01",
            "pass_type": "Student Pass",
            "passenger_count": 2,
            "valid_until": "2099-12-31",
        })
        self.assertEqual(pass_response.status_code, 201)
        passenger_pass = pass_response.json()["pass"]
        self.assertEqual(passenger_pass["bus_trip_id"], trip_record_id)

        summary = self.client.get(f"/api/conductor/trips/{trip_record_id}").json()["summary"]
        self.assertEqual(summary["ticket_count"], 1)
        self.assertEqual(summary["ticket_passengers"], 4)
        self.assertEqual(summary["pass_count"], 1)
        self.assertEqual(summary["pass_passengers"], 2)
        breakdown = {row["category_code"]: row for row in summary["passenger_categories"]}
        self.assertEqual(breakdown["FULL"]["passengers"], 2)
        self.assertEqual(breakdown["HALF"]["passengers"], 1)

    def test_03_checkpoint_writes_expected_vision_and_alert_links(self):
        started = self.start_trip(
            "BKG-CHECK-01",
            bus_id="MH-09-CV-3372",
            route="Pune - Kolhapur",
        )
        self.assertEqual(started.status_code, 200)
        trip_record_id = started.json()["trip"]["id"]

        saved = self.client.post("/api/conductor/checkpoint", json={
            "bus_id": "MH-09-CV-3372",
            "route": "Pune - Kolhapur",
            "trip_id": "BKG-CHECK-01",
            "checkpoint": "BKG Toll",
            "conductor_id": "A. Jadhav",
            "active_tickets": 60,
            "valid_passes": 10,
            "other_authorized": 4,
            "starting_onboard": 40,
            "boarded": 8,
            "alighted": 3,
            "camera_estimate": 72,
        })
        self.assertEqual(saved.status_code, 201)
        body = saved.json()
        self.assertEqual(body["bus_trip_id"], trip_record_id)
        self.assertIsNotNone(body["expected_count_id"])
        self.assertIsNotNone(body["vision_count_id"])

        expected = self.fetch_one(
            "SELECT * FROM expected_passenger_counts WHERE id = ?",
            (body["expected_count_id"],),
        )
        self.assertEqual(expected["bus_trip_id"], trip_record_id)
        self.assertEqual(expected["expected_count"], 45)
        self.assertEqual(expected["reported_count"], 74)

        vision = self.fetch_one(
            "SELECT * FROM computer_vision_counts WHERE id = ?",
            (body["vision_count_id"],),
        )
        self.assertEqual(vision["bus_trip_id"], trip_record_id)
        self.assertEqual(vision["detected_count"], 72)
        self.assertEqual(vision["checkpoint"], "BKG Toll")

        self.assertIsNotNone(body["alert"])
        alert = self.fetch_one(
            "SELECT * FROM mismatch_alerts WHERE id = ?",
            (body["alert"]["id"],),
        )
        self.assertEqual(alert["bus_trip_id"], trip_record_id)
        self.assertEqual(alert["expected_count_id"], body["expected_count_id"])
        self.assertEqual(alert["vision_count_id"], body["vision_count_id"])

        summary = self.client.get(f"/api/conductor/trips/{trip_record_id}").json()["summary"]
        self.assertEqual(summary["checkpoint_count"], 1)
        self.assertEqual(summary["expected_count"], 1)
        self.assertEqual(summary["vision_count"], 1)
        self.assertEqual(summary["latest_expected_count"], 45)
        self.assertEqual(summary["latest_reported_count"], 74)
        self.assertEqual(summary["latest_vision_count"], 72)
        self.assertEqual(summary["latest_difference"], 2)
        self.assertEqual(summary["mismatch_count"], 1)

    def test_04_manual_dispatch_inherits_alert_trip(self):
        started = self.start_trip(
            "BKG-DISPATCH-01",
            bus_id="MH-15-GH-4417",
            route="Pune - Nashik",
        )
        self.assertEqual(started.status_code, 200)
        trip_record_id = started.json()["trip"]["id"]

        saved = self.client.post("/api/conductor/checkpoint", json={
            "bus_id": "MH-15-GH-4417",
            "route": "Pune - Nashik",
            "trip_id": "BKG-DISPATCH-01",
            "checkpoint": "Dispatch Toll",
            "active_tickets": 20,
            "valid_passes": 0,
            "other_authorized": 0,
            "starting_onboard": 15,
            "boarded": 0,
            "alighted": 0,
            "camera_estimate": 17,
        })
        self.assertEqual(saved.status_code, 201)
        alert = saved.json()["alert"]
        self.assertIsNotNone(alert)
        self.assertEqual(alert["bus_trip_id"], trip_record_id)
        self.assertIsNotNone(alert["dispatch"])
        self.assertEqual(alert["dispatch"]["bus_trip_id"], trip_record_id)
        self.assertEqual(alert["dispatch"]["trip_id"], "BKG-DISPATCH-01")
        self.assertEqual(alert["dispatch"]["route"], "Pune - Nashik")

        checkers = self.client.get("/api/checkers")
        self.assertEqual(checkers.status_code, 200)
        available = [
            row for row in checkers.json()["checkers"]
            if row["availability"] == "Available"
        ]
        self.assertTrue(available)

        dispatch_response = self.client.post("/api/checker-dispatches", json={
            "bus_id": "MH-01-CD-7834",
            "checker_id": available[0]["id"],
        })
        self.assertEqual(dispatch_response.status_code, 201, dispatch_response.text)
        dispatch = dispatch_response.json()["dispatch"]
        self.assertIsNotNone(dispatch["bus_trip_id"])
        self.assertEqual(dispatch["trip_id"], "TRIP-1320-04")
        self.assertEqual(
            conductor_db._route_key(dispatch["route"]),
            conductor_db._route_key("Mumbai - Nashik"),
        )

    def test_05_complete_trip_is_idempotent(self):
        started = self.start_trip(
            "BKG-COMPLETE-01",
            bus_id="MH-11-AX-2208",
            route="Pune - Solapur",
        )
        self.assertEqual(started.status_code, 200)
        trip_record_id = started.json()["trip"]["id"]

        completed = self.client.post(f"/api/conductor/trips/{trip_record_id}/complete")
        self.assertEqual(completed.status_code, 200)
        trip = completed.json()["trip"]
        self.assertEqual(trip["status"], "Completed")
        self.assertTrue(trip["ended_at"])

        repeated = self.client.post(f"/api/conductor/trips/{trip_record_id}/complete")
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["trip"]["status"], "Completed")

        active = self.client.get(
            "/api/conductor/trips/active",
            params={"bus_id": "MH-11-AX-2208"},
        )
        self.assertEqual(active.status_code, 404)

        missing = self.client.post("/api/conductor/trips/999999/complete")
        self.assertEqual(missing.status_code, 404)

    def test_06_invalid_trip_details_are_rejected(self):
        mismatch = self.start_trip(
            "BKG-BAD-ROUTE",
            bus_id="MH-12-QW-4821",
            route="Pune - Nashik",
        )
        self.assertEqual(mismatch.status_code, 400)

        unknown = self.start_trip(
            "BKG-UNKNOWN-BUS",
            bus_id="MH-00-XX-0000",
            route="Pune - Mumbai",
        )
        self.assertEqual(unknown.status_code, 400)

        conflicting = self.start_trip("BKG-SECOND-ACTIVE")
        self.assertEqual(conflicting.status_code, 400)

        route_conflict = self.start_trip(
            "BKG-TRIP-01",
            bus_id="MH-12-QW-4821",
            route="Pune - Nashik",
        )
        self.assertEqual(route_conflict.status_code, 400)

        missing_ticket = self.client.get("/api/conductor/tickets/999999")
        self.assertEqual(missing_ticket.status_code, 404)


if __name__ == "__main__":
    unittest.main()
