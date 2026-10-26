"""Focused tests for the active-trip camera and ETM comparison dashboard."""

import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from backend import alert_dispatch, conductor_db, etm_db, main


class TripComparisonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp_dir = tempfile.mkdtemp(prefix="smartst_trip_comparison_test_")
        conductor_db.DB_PATH = os.path.join(cls.tmp_dir, "trip_comparison.db")
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

    def start_trip(self, bus_id, trip_id, route="Pune - Mumbai"):
        response = self.client.post("/api/conductor/trips", json={
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "conductor_id": "Test Conductor",
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["trip"]

    def issue_ticket(self, bus_id, trip_id, route="Pune - Mumbai", full=0, half=0, free=0):
        response = self.client.post("/api/conductor/tickets", json={
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "full_count": full,
            "half_count": half,
            "free_count": free,
        })
        self.assertEqual(response.status_code, 201, response.text)

    def comparison_for(self, bus_id, tolerance=None):
        params = {} if tolerance is None else {"tolerance": tolerance}
        response = self.client.get("/api/comparisons/active-trips", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return next(row for row in response.json()["comparisons"] if row["bus_id"] == bus_id)

    def test_01_detected_minus_expected_is_reported(self):
        bus_id = "MH-12-QW-4821"
        self.start_trip(bus_id, "CMP-MATCH-01")
        self.issue_ticket(bus_id, "CMP-MATCH-01", full=2, free=1)
        conductor_db.record_latest_detection(bus_id, 3)

        row = self.comparison_for(bus_id)
        self.assertEqual(row["expected_passengers"], 3)
        self.assertEqual(row["detected_passengers"], 3)
        self.assertEqual(row["difference"], 0)
        self.assertEqual(row["status"], "Match")
        self.assertFalse(row["is_mismatch"])
        self.assertTrue(row["within_tolerance"])

    def test_02_tolerance_and_mismatch_are_distinct(self):
        bus_id = "MH-11-AX-2208"
        route = "Pune – Solapur"
        self.start_trip(bus_id, "CMP-MISMATCH-01", route=route)
        self.issue_ticket(bus_id, "CMP-MISMATCH-01", route=route, full=3)
        conductor_db.record_latest_detection(bus_id, 5)

        within = self.comparison_for(bus_id, tolerance=2)
        self.assertEqual(within["difference"], 2)
        self.assertEqual(within["status"], "Within tolerance")
        self.assertFalse(within["is_mismatch"])

        mismatch = self.comparison_for(bus_id, tolerance=1)
        self.assertEqual(mismatch["difference"], 2)
        self.assertEqual(mismatch["status"], "Mismatch")
        self.assertTrue(mismatch["is_mismatch"])

    def test_03_stale_camera_is_not_compared(self):
        bus_id = "MH-15-GH-4417"
        self.start_trip(bus_id, "CMP-STALE-01", route="Pune – Nashik")
        conductor_db.record_latest_detection(bus_id, 4)
        old_timestamp = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        conn = conductor_db.get_db_connection()
        try:
            conn.execute(
                "UPDATE latest_detections SET updated_at = ? WHERE bus_id = ?",
                (old_timestamp, bus_id),
            )
            conn.commit()
        finally:
            conn.close()

        row = self.comparison_for(bus_id)
        self.assertEqual(row["status"], "Stale")
        self.assertIsNone(row["detected_passengers"])
        self.assertIsNone(row["difference"])
        self.assertFalse(row["is_mismatch"])

    def test_04_camera_unavailable_is_not_a_zero_count(self):
        bus_id = "MH-09-CV-3372"
        self.start_trip(bus_id, "CMP-UNAVAILABLE-01", route="Pune - Kolhapur")
        row = self.comparison_for(bus_id)
        self.assertEqual(row["status"], "Camera unavailable")
        self.assertIsNone(row["detected_passengers"])
        self.assertIsNone(row["difference"])
        self.assertFalse(row["is_mismatch"])


if __name__ == "__main__":
    unittest.main()
