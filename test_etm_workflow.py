"""
Focused regression tests for ETM ticketing, pass registration, analytics and
the checker inspection workflow.

Run from the project root:
    python -m unittest test_etm_workflow -v
"""

import os
import shutil
import tempfile
import unittest

from fastapi.testclient import TestClient

from backend import alert_dispatch, conductor_db, etm_db, main


class EtmWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp_dir = tempfile.mkdtemp(prefix="smartst_etm_test_")
        conductor_db.DB_PATH = os.path.join(cls.tmp_dir, "conductor_etm_test.db")
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

    def test_01_fare_defaults_and_updates(self):
        res = self.client.get("/api/conductor/fares", params={"route": "Pune – Mumbai"})
        self.assertEqual(res.status_code, 200)
        fares = res.json()["fares"]
        self.assertEqual(fares["full_fare"], 120.0)
        self.assertEqual(fares["half_fare"], 60.0)

        res = self.client.post("/api/conductor/fares", json={
            "route": "Pune – Mumbai",
            "full_fare": 150,
            "half_fare": 75,
            "free_fare": 0,
            "currency": "INR",
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["fares"]["full_fare"], 150.0)

        res = self.client.post("/api/conductor/fares", json={
            "route": "Pune – Mumbai",
            "full_fare": 100,
            "half_fare": 120,
        })
        self.assertEqual(res.status_code, 400)

    def test_02_issue_ticket_and_summary(self):
        res = self.client.post("/api/conductor/tickets", json={
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-ETM-01",
            "conductor_id": "A. Jadhav",
            "full_count": 2,
            "half_count": 1,
            "free_count": 1,
        })
        self.assertEqual(res.status_code, 201)
        body = res.json()
        ticket = body["ticket"]
        self.assertRegex(ticket["ticket_number"], r"^ST-\d{8}-\d{5}$")
        self.assertEqual(ticket["total_passengers"], 4)
        self.assertEqual(ticket["total_fare"], 375.0)
        self.assertEqual(body["summary"]["ticket_passengers"], 4)

        res = self.client.post("/api/conductor/tickets", json={
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-ETM-01",
            "full_count": 0,
            "half_count": 0,
            "free_count": 0,
        })
        self.assertEqual(res.status_code, 400)

    def test_03_register_pass_and_cancel(self):
        res = self.client.post("/api/conductor/passes", json={
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-ETM-01",
            "pass_type": "Student Pass",
            "passenger_count": 2,
            "valid_until": "2099-12-31",
        })
        self.assertEqual(res.status_code, 201)
        body = res.json()
        passenger_pass = body["pass"]
        self.assertRegex(passenger_pass["pass_number"], r"^PS-\d{8}-\d{5}$")
        self.assertEqual(body["summary"]["pass_passengers"], 2)
        self.assertEqual(body["summary"]["expected_passengers"], 6)

        res = self.client.post(f"/api/conductor/passes/{passenger_pass['id']}/cancel")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["summary"]["pass_passengers"], 0)

    def test_04_checkpoint_prefers_etm_totals(self):
        res = self.client.post("/api/conductor/checkpoint", json={
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-ETM-01",
            "checkpoint": "Lonavala",
            "active_tickets": 0,
            "valid_passes": 0,
            "starting_onboard": 10,
            "boarded": 0,
            "alighted": 0,
            "camera_estimate": 7,
            "use_ticketing_totals": True,
        })
        self.assertEqual(res.status_code, 201)
        body = res.json()
        self.assertEqual(body["active_tickets"], 4)
        self.assertEqual(body["valid_passes"], 0)
        self.assertEqual(body["reported_passengers"], 4)
        self.assertEqual(body["ticketing_source"], "etm")
        self.assertEqual(body["ticket_count"], 1)
        self.assertEqual(body["difference"], -3)

        res = self.client.post("/api/conductor/checkpoint", json={
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-ETM-01",
            "checkpoint": "Manual Override",
            "active_tickets": 9,
            "valid_passes": 1,
            "starting_onboard": 10,
            "use_ticketing_totals": False,
        })
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()["ticketing_source"], "manual")
        self.assertEqual(res.json()["reported_passengers"], 10)

    def test_06_ticket_history_unique_numbers_and_cancel(self):
        context = {
            "bus_id": "MH-09-CV-3372",
            "route": "Pune - Kolhapur",
            "trip_id": "TRIP-TICKET-HISTORY",
        }
        empty = self.client.get("/api/conductor/tickets", params=context)
        self.assertEqual(empty.status_code, 200)
        self.assertEqual(empty.json()["count"], 0)

        first_payload = {
            **context,
            "conductor_id": "R. Shinde",
            "full_count": 2,
            "half_count": 1,
            "free_count": 0,
        }
        first = self.client.post("/api/conductor/tickets", json=first_payload)
        self.assertEqual(first.status_code, 201, first.text)
        first_ticket = first.json()["ticket"]
        self.assertRegex(first_ticket["ticket_number"], r"^ST-\d{8}-\d{5}$")
        self.assertEqual(first_ticket["total_passengers"], 3)
        self.assertEqual(first_ticket["total_fare"], 300.0)

        second_payload = {
            **context,
            "conductor_id": "R. Shinde",
            "full_count": 0,
            "half_count": 0,
            "free_count": 1,
        }
        second = self.client.post("/api/conductor/tickets", json=second_payload)
        self.assertEqual(second.status_code, 201, second.text)
        second_ticket = second.json()["ticket"]
        self.assertRegex(second_ticket["ticket_number"], r"^ST-\d{8}-\d{5}$")
        self.assertNotEqual(first_ticket["ticket_number"], second_ticket["ticket_number"])
        self.assertNotEqual(first_ticket["id"], second_ticket["id"])

        history = self.client.get("/api/conductor/tickets", params={**context, "limit": 10})
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.json()["count"], 2)
        self.assertEqual(
            {row["id"] for row in history.json()["tickets"]},
            {first_ticket["id"], second_ticket["id"]},
        )

        detail = self.client.get(f"/api/conductor/tickets/{first_ticket['id']}")
        self.assertEqual(detail.status_code, 200)
        categories = {
            row["category_code"]: row
            for row in detail.json()["ticket"]["passenger_categories"]
        }
        self.assertEqual(categories["FULL"]["passenger_count"], 2)
        self.assertEqual(categories["FULL"]["line_total"], 240.0)
        self.assertEqual(categories["HALF"]["line_total"], 60.0)

        summary = self.client.get("/api/conductor/ticketing/summary", params={
            "bus_id": context["bus_id"],
            "trip_id": context["trip_id"],
            "route": context["route"],
        })
        self.assertEqual(summary.status_code, 200)
        totals = summary.json()["summary"]
        self.assertEqual(totals["ticket_count"], 2)
        self.assertEqual(totals["ticket_passengers"], 4)
        self.assertEqual(totals["ticket_revenue"], 300.0)
        self.assertEqual(totals["expected_passengers"], 4)

        cancelled = self.client.post(f"/api/conductor/tickets/{second_ticket['id']}/cancel")
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json()["ticket"]["status"], "Cancelled")
        self.assertEqual(cancelled.json()["summary"]["ticket_count"], 1)
        self.assertEqual(cancelled.json()["summary"]["ticket_passengers"], 3)
        self.assertEqual(cancelled.json()["summary"]["ticket_revenue"], 300.0)

        repeated = self.client.post(f"/api/conductor/tickets/{second_ticket['id']}/cancel")
        self.assertEqual(repeated.status_code, 400)

        cancelled_history = self.client.get("/api/conductor/tickets", params={
            **context,
            "status": "Cancelled",
        })
        self.assertEqual(cancelled_history.status_code, 200)
        self.assertEqual(
            [row["id"] for row in cancelled_history.json()["tickets"]],
            [second_ticket["id"]],
        )
        invalid_status = self.client.get("/api/conductor/tickets", params={
            **context,
            "status": "Refunded",
        })
        self.assertEqual(invalid_status.status_code, 400)

    def test_07_duplicate_ticket_submissions_are_idempotent(self):
        context = {
            "bus_id": "MH-11-AX-2208",
            "route": "Pune - Solapur",
            "trip_id": "TRIP-TICKET-IDEMPOTENT",
        }
        payload = {
            **context,
            "conductor_id": "M. Patil",
            "full_count": 1,
            "half_count": 0,
            "free_count": 0,
            "client_request_id": "ticket-retry-001",
        }
        first = self.client.post("/api/conductor/tickets", json=payload)
        self.assertEqual(first.status_code, 201, first.text)
        self.assertFalse(first.json()["duplicate"])
        ticket = first.json()["ticket"]

        replay = self.client.post("/api/conductor/tickets", json=payload)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["duplicate"])
        self.assertEqual(replay.json()["ticket"]["id"], ticket["id"])
        self.assertEqual(
            replay.json()["ticket"]["ticket_number"],
            ticket["ticket_number"],
        )
        self.assertEqual(replay.json()["summary"]["ticket_count"], 1)
        self.assertEqual(replay.json()["summary"]["ticket_passengers"], 1)

        conflict = self.client.post("/api/conductor/tickets", json={
            **payload,
            "full_count": 2,
        })
        self.assertEqual(conflict.status_code, 409, conflict.text)
        summary = self.client.get("/api/conductor/ticketing/summary", params=context)
        self.assertEqual(summary.json()["summary"]["ticket_count"], 1)
        self.assertEqual(summary.json()["summary"]["ticket_passengers"], 1)

        header_key = "ticket-header-retry-001"
        header_payload = {
            **context,
            "full_count": 1,
            "half_count": 0,
            "free_count": 0,
        }
        header_first = self.client.post(
            "/api/conductor/tickets",
            json=header_payload,
            headers={"Idempotency-Key": header_key},
        )
        self.assertEqual(header_first.status_code, 201, header_first.text)
        header_replay = self.client.post(
            "/api/conductor/tickets",
            json=header_payload,
            headers={"Idempotency-Key": header_key},
        )
        self.assertEqual(header_replay.status_code, 200, header_replay.text)
        self.assertEqual(
            header_replay.json()["ticket"]["id"],
            header_first.json()["ticket"]["id"],
        )
        self.assertEqual(header_replay.json()["summary"]["ticket_count"], 2)

    def test_08_passenger_categories_and_route_stops(self):
        categories = self.client.get("/api/conductor/passenger-categories")
        self.assertEqual(categories.status_code, 200)
        self.assertGreaterEqual(categories.json()["count"], 3)

        created = self.client.post("/api/conductor/passenger-categories", json={
            "code": "senior",
            "label": "Senior citizen",
            "fare_basis": "half",
            "sort_order": 10,
            "active": True,
        })
        self.assertEqual(created.status_code, 200, created.text)
        category = created.json()["category"]
        self.assertEqual(category["code"], "SENIOR")
        self.assertEqual(category["fare_basis"], "half")
        self.assertTrue(category["active"])

        invalid = self.client.post("/api/conductor/passenger-categories", json={
            "code": "BAD BASIS",
            "label": "Invalid",
            "fare_basis": "discount",
        })
        self.assertEqual(invalid.status_code, 400)

        updated = self.client.post("/api/conductor/passenger-categories", json={
            "code": "SENIOR",
            "label": "Senior passenger",
            "fare_basis": "half",
            "sort_order": 10,
            "active": True,
        })
        self.assertEqual(updated.status_code, 200, updated.text)

        etm_db.init_db()
        persisted = self.client.get("/api/conductor/passenger-categories")
        senior = next(
            row for row in persisted.json()["categories"] if row["code"] == "SENIOR"
        )
        self.assertEqual(senior["label"], "Senior passenger")

        stops = self.client.get("/api/conductor/route-stops", params={
            "route": "Pune – Mumbai",
            "bus_id": "MH-12-QW-4821",
        })
        self.assertEqual(stops.status_code, 200)
        names = stops.json()["stops"]
        self.assertIn("Pune", names)
        self.assertIn("Mumbai", names)
        self.assertIn("Lonavala", names)

    def test_09_itemised_ticket_snapshots_stops_and_retry(self):
        context = {
            "bus_id": "MH-14-BT-1906",
            "route": "Pune – Nashik",
            "trip_id": "TRIP-ETM-INSPECTION",
        }
        payload = {
            **context,
            "conductor_id": "S. Pawar",
            "boarding_stop": "Pune",
            "destination_stop": "Nashik",
            "items": [
                {"category_code": "FULL", "quantity": 1},
                {"category_code": "SENIOR", "quantity": 2},
                {"category_code": "FREE", "quantity": 1},
            ],
            "client_request_id": "ticket-category-retry-001",
        }
        first = self.client.post("/api/conductor/tickets", json=payload)
        self.assertEqual(first.status_code, 201, first.text)
        ticket = first.json()["ticket"]
        self.assertEqual(ticket["total_passengers"], 4)
        self.assertEqual(ticket["total_fare"], 240.0)
        self.assertEqual(ticket["boarding_stop"], "Pune")
        self.assertEqual(ticket["destination_stop"], "Nashik")

        breakdown = {
            row["category_code"]: row for row in ticket["passenger_categories"]
        }
        self.assertEqual(breakdown["SENIOR"]["passenger_count"], 2)
        self.assertEqual(breakdown["SENIOR"]["category_label"], "Senior passenger")
        self.assertEqual(breakdown["SENIOR"]["fare_basis"], "half")
        self.assertEqual(breakdown["SENIOR"]["unit_fare"], 60.0)
        self.assertEqual(breakdown["FULL"]["line_total"], 120.0)
        self.assertEqual(breakdown["FREE"]["line_total"], 0.0)

        replay = self.client.post("/api/conductor/tickets", json=payload)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["duplicate"])
        self.assertEqual(replay.json()["ticket"]["id"], ticket["id"])

        conflict = self.client.post("/api/conductor/tickets", json={
            **payload,
            "destination_stop": "Igatpuri",
        })
        self.assertEqual(conflict.status_code, 409, conflict.text)

        stops = self.client.get("/api/conductor/route-stops", params={
            "route": context["route"],
        })
        self.assertEqual(stops.status_code, 200)
        self.assertEqual(stops.json()["stops"][:2], ["Pune", "Nashik"])

    def test_05_analytics_and_inspection_workflow(self):
        res = self.client.get("/api/analytics/passengers", params={"days": 7})
        self.assertEqual(res.status_code, 200)
        analytics = res.json()["analytics"]
        self.assertGreaterEqual(analytics["summary"]["ticket_count"], 1)
        self.assertGreaterEqual(analytics["summary"]["checkpoint_count"], 1)
        self.assertEqual(len(analytics["trend"]["labels"]), 7)

        ticket_bus = next(
            row for row in analytics["bus_breakdown"]
            if row["bus_id"] == "MH-12-QW-4821"
        )
        self.assertEqual(ticket_bus["ticket_passengers"], 4)
        self.assertEqual(ticket_bus["pass_passengers"], 0)

        res = self.client.get("/api/analytics/passengers", params={
            "days": 7,
            "route": "Pune – Mumbai",
        })
        self.assertEqual(res.status_code, 200)
        filtered = res.json()["analytics"]
        self.assertEqual(filtered["route"], "Pune – Mumbai")
        self.assertTrue(all(row["route"] == "Pune – Mumbai" for row in filtered["route_breakdown"]))
        self.assertTrue(all(row["route"] == "Pune – Mumbai" for row in filtered["bus_breakdown"]))
        self.assertEqual(filtered["summary"]["ticket_passengers"], 4)

        res = self.client.get("/api/checkers")
        self.assertEqual(res.status_code, 200)
        available = [row for row in res.json()["checkers"] if row["availability"] == "Available"]
        self.assertTrue(available)

        res = self.client.post("/api/checker-dispatches", json={
            "bus_id": "MH-14-BT-1906",
            "checker_id": available[0]["id"],
            "location": "Test checkpoint",
            "checkpoint": "Sangamner",
            "route": "Pune – Nashik",
            "trip_id": "TRIP-ETM-INSPECTION",
        })
        self.assertEqual(res.status_code, 201)
        dispatch = res.json()["dispatch"]
        self.assertEqual(dispatch["status"], "Dispatched")

        res = self.client.post(f"/api/checker-dispatches/{dispatch['id']}/complete", json={
            "outcome": "Mismatch Confirmed",
            "notes": "Two passengers without tickets.",
            "mismatch_confirmed": True,
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["dispatch"]["status"], "Completed")

        res = self.client.get("/api/inspections")
        self.assertEqual(res.status_code, 200)
        inspection = next(
            row for row in res.json()["inspections"]
            if row["dispatch_id"] == dispatch["id"]
        )
        self.assertEqual(inspection["outcome"], "Mismatch Confirmed")
        self.assertTrue(inspection["completed_at"])

    def test_10_pass_acknowledgement_stops_and_validity(self):
        context = {
            "bus_id": "MH-12-JK-9083",
            "route": "Pune - Mumbai",
            "trip_id": "TRIP-PASS-VALIDITY-01",
            "conductor_id": "V. Koli",
        }
        payload = {
            **context,
            "pass_number": "PS-TEST-0001",
            "pass_type": "Student Pass",
            "passenger_count": 2,
            "valid_from": "2020-01-01",
            "valid_until": "2099-12-31",
            "boarding_stop": "Pune",
            "destination_stop": "Kolhapur",
            "notes": "Student group pass",
        }

        created = self.client.post("/api/conductor/passes", json=payload)
        self.assertEqual(created.status_code, 201, created.text)
        body = created.json()
        passenger_pass = body["pass"]
        self.assertRegex(passenger_pass["acknowledgement_id"], r"^PA-\d{8}-\d{5}$")
        self.assertEqual(passenger_pass["pass_number"], "PS-TEST-0001")
        self.assertEqual(passenger_pass["boarding_stop"], "Pune")
        self.assertEqual(passenger_pass["destination_stop"], "Kolhapur")
        self.assertEqual(passenger_pass["notes"], "Student group pass")
        self.assertEqual(passenger_pass["validity_status"], "Valid")
        self.assertTrue(passenger_pass["valid_now"])
        self.assertEqual(body["summary"]["pass_passengers"], 2)

        duplicate = self.client.post("/api/conductor/passes", json=payload)
        self.assertEqual(duplicate.status_code, 400, duplicate.text)
        self.assertIn("already exists", duplicate.json()["detail"].lower())

        unpaired = self.client.post("/api/conductor/passes", json={
            **payload,
            "pass_number": "PS-TEST-UNPAIRED",
            "boarding_stop": "Pune",
            "destination_stop": "",
        })
        self.assertEqual(unpaired.status_code, 400, unpaired.text)

        reversed_dates = self.client.post("/api/conductor/passes", json={
            **payload,
            "pass_number": "PS-TEST-DATES",
            "valid_from": "2099-12-31",
            "valid_until": "2020-01-01",
        })
        self.assertEqual(reversed_dates.status_code, 400, reversed_dates.text)

        scheduled = self.client.post("/api/conductor/passes", json={
            **payload,
            "pass_number": "PS-TEST-SCHEDULED",
            "passenger_count": 3,
            "valid_from": "2099-01-01",
            "valid_until": "2099-12-31",
            "boarding_stop": "",
            "destination_stop": "",
        })
        self.assertEqual(scheduled.status_code, 201, scheduled.text)
        scheduled_pass = scheduled.json()["pass"]
        self.assertEqual(scheduled_pass["validity_status"], "Scheduled")
        self.assertFalse(scheduled_pass["valid_now"])
        self.assertEqual(scheduled.json()["summary"]["pass_passengers"], 2)

        listed = self.client.get("/api/conductor/passes", params={
            "bus_id": context["bus_id"],
            "trip_id": context["trip_id"],
        })
        self.assertEqual(listed.status_code, 200)
        statuses = {
            row["pass_number"]: row["validity_status"]
            for row in listed.json()["passes"]
        }
        self.assertEqual(statuses["PS-TEST-0001"], "Valid")
        self.assertEqual(statuses["PS-TEST-SCHEDULED"], "Scheduled")

        checkpoint = self.client.post("/api/conductor/checkpoint", json={
            **context,
            "checkpoint": "Pass Validity Check",
            "active_tickets": 0,
            "valid_passes": 0,
            "other_authorized": 0,
            "starting_onboard": 10,
            "boarded": 0,
            "alighted": 0,
            "camera_estimate": 10,
            "use_ticketing_totals": True,
        })
        self.assertEqual(checkpoint.status_code, 201, checkpoint.text)
        self.assertEqual(checkpoint.json()["valid_passes"], 2)
        self.assertEqual(checkpoint.json()["reported_passengers"], 2)


if __name__ == "__main__":
    unittest.main()
