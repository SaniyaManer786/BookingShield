"""
Focused regression tests for the SMART ST Conductor Panel.

Covers the acceptance criteria:
  * difference = reported_passengers - camera_estimate (signed) + absolute
  * status wording ("Match" / "Mismatch: N passengers" / "Camera unavailable")
  * no stale camera snapshot is attached when the panel says the camera is down
  * checkpoint POST really persists and is returned by the history/latest GETs
  * invalid counts are rejected with 400
  * health, routes, checkpoint-options and camera-state endpoints work

Run from the project root:
    python -m unittest test_conductor_panel_api -v
"""

import os
import shutil
import tempfile
import unittest

from fastapi.testclient import TestClient

from backend import alert_dispatch, conductor_db, main


class ConductorPanelApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp_dir = tempfile.mkdtemp(prefix="smartst_conductor_test_")
        conductor_db.DB_PATH = os.path.join(cls.tmp_dir, "conductor_test.db")
        conductor_db.init_db()
        alert_dispatch.init_db()

        # Never load the real YOLO weights in unit tests; health only needs the
        # flag to decide between healthy/degraded.
        cls._original_model = main.yolo_model
        main.yolo_model = object()
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        main.yolo_model = cls._original_model
        shutil.rmtree(cls.tmp_dir, ignore_errors=True)

    # ------------------------------------------------------------------ #
    # Helpers                                                            #
    # ------------------------------------------------------------------ #

    def submit(self, **overrides):
        payload = {
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-TEST-01",
            "checkpoint": "Khopoli Toll",
            "conductor_id": "A. Jadhav",
            "active_tickets": 60,
            "valid_passes": 10,
            "other_authorized": 4,   # reported = 74
            "starting_onboard": 40,
            "boarded": 8,
            "alighted": 3,           # expected = 45
            "notes": "unit test",
        }
        payload.update(overrides)
        return self.client.post("/api/conductor/checkpoint", json=payload)

    # ------------------------------------------------------------------ #
    # Health / reference data                                            #
    # ------------------------------------------------------------------ #

    def test_01_health_reports_database(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertIn("database_ok", body)
        self.assertTrue(body["database_ok"])
        self.assertTrue(body["database_path"].replace("\\", "/").endswith("conductor_test.db"))

    def test_02_routes_and_checkpoint_options(self):
        res = self.client.get("/api/conductor/routes")
        self.assertEqual(res.status_code, 200)
        routes = [row["route"] for row in res.json()["routes"]]
        self.assertIn("Pune – Mumbai", routes)

        saved = self.submit(checkpoint="Lonavala Bypass")
        self.assertEqual(saved.status_code, 201)

        res = self.client.get(
            "/api/conductor/checkpoint-options",
            params={"bus_id": "MH-12-QW-4821"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("Lonavala Bypass", res.json()["checkpoints"])

    # ------------------------------------------------------------------ #
    # Core calculation                                                   #
    # ------------------------------------------------------------------ #

    def test_03_difference_is_reported_minus_camera(self):
        saved = self.submit(camera_estimate=72)
        self.assertEqual(saved.status_code, 201)
        data = saved.json()

        self.assertEqual(data["reported_passengers"], 74)
        self.assertEqual(data["expected_onboard"], 45)
        self.assertEqual(data["camera_estimate"], 72)
        self.assertEqual(data["difference"], 2)          # 74 - 72
        self.assertEqual(data["difference_abs"], 2)
        self.assertEqual(data["comparison_status_label"], "Mismatch: 2 passengers")
        self.assertEqual(data["comparison_status"], "Discrepancy — verify")  # historical stored wording
        self.assertIsNotNone(data["alert"])              # mismatch workflow still runs

    def test_04_difference_negative_when_camera_higher(self):
        saved = self.submit(camera_estimate=80, checkpoint="Negative Diff")
        self.assertEqual(saved.status_code, 201)
        data = saved.json()
        self.assertEqual(data["difference"], -6)         # 74 - 80
        self.assertEqual(data["difference_abs"], 6)

    def test_05_exact_match_counts_as_match(self):
        saved = self.submit(camera_estimate=74, checkpoint="Exact Match")
        self.assertEqual(saved.status_code, 201)
        data = saved.json()
        self.assertEqual(data["difference"], 0)
        self.assertEqual(data["difference_abs"], 0)
        self.assertEqual(data["comparison_status_label"], "Match")

    # ------------------------------------------------------------------ #
    # Camera unavailable / stale safety                                  #
    # ------------------------------------------------------------------ #

    def test_06_unavailable_camera_is_never_compared(self):
        conductor_db.record_latest_detection("MH-14-BT-1906", count=99)
        res = self.submit(
            bus_id="MH-14-BT-1906",
            checkpoint="Camera Down",
            camera_available=False,
            camera_estimate=None,
        )
        self.assertEqual(res.status_code, 201)
        data = res.json()
        self.assertIsNone(data["camera_estimate"])       # stale 99 is NOT attached
        self.assertIsNone(data["difference"])
        self.assertIsNone(data["difference_abs"])
        self.assertEqual(data["comparison_status"], "Comparison unavailable")
        self.assertEqual(data["comparison_status_label"], "Camera unavailable")
        self.assertIsNone(data["alert"])

    def test_07_no_camera_data_ever(self):
        res = self.submit(bus_id="MH-09-CV-3372", checkpoint="No Camera Bus")
        self.assertEqual(res.status_code, 201)
        data = res.json()
        self.assertIsNone(data["camera_estimate"])
        self.assertIsNone(data["difference"])

    def test_08_camera_state_endpoint_returns_real_count(self):
        conductor_db.record_latest_detection("MH-12-QW-4821", count=72, inference_time_ms=12.5)
        res = self.client.get(
            "/api/conductor/camera-state",
            params={"bus_id": "MH-12-QW-4821"},
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["count"], 72)
        self.assertEqual(body["status"], "connected")
        self.assertFalse(body["stale"])

    # ------------------------------------------------------------------ #
    # Persistence                                                        #
    # ------------------------------------------------------------------ #

    def test_09_submission_persists_and_appears_in_history_and_latest(self):
        res = self.submit(checkpoint="Persistence Check", camera_estimate=72)
        self.assertEqual(res.status_code, 201)
        saved = res.json()

        history = self.client.get(
            "/api/conductor/checkpoints",
            params={"bus_id": "MH-12-QW-4821", "limit": 10},
        )
        self.assertEqual(history.status_code, 200)
        ids = [row["id"] for row in history.json()["checkpoints"]]
        self.assertIn(saved["id"], ids)

        latest = self.client.get(
            "/api/conductor/checkpoint/latest",
            params={"bus_id": "MH-12-QW-4821"},
        )
        self.assertEqual(latest.status_code, 200)
        self.assertEqual(latest.json()["checkpoint"]["id"], saved["id"])

        by_id = self.client.get(f"/api/conductor/checkpoint/{saved['id']}")
        self.assertEqual(by_id.status_code, 200)
        self.assertEqual(by_id.json()["checkpoint"]["checkpoint"], "Persistence Check")

    # ------------------------------------------------------------------ #
    # Validation                                                         #
    # ------------------------------------------------------------------ #

    def test_10_invalid_counts_are_rejected(self):
        cases = [
            {"active_tickets": -1},
            {"valid_passes": 501},
            {"starting_onboard": "abc"},
            {"checkpoint": ""},
            {"starting_onboard": 5, "boarded": 1, "alighted": 10},  # negative expected
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                res = self.submit(**overrides)
                self.assertEqual(res.status_code, 400, res.text)
                self.assertIn("detail", res.json())

    def test_11_missing_required_fields_are_rejected(self):
        res = self.client.post("/api/conductor/checkpoint", json={"bus_id": "MH-12-QW-4821"})
        self.assertEqual(res.status_code, 400)

    # ------------------------------------------------------------------ #
    # Live-count freshness                                               #
    # ------------------------------------------------------------------ #

    def test_12_stale_detection_is_never_used_as_live_camera_data(self):
        bus_id = "MH-15-GH-4417"
        conductor_db.record_latest_detection(bus_id, count=30, inference_time_ms=11.0)

        # Backdate the stored frame well beyond CAMERA_COUNT_STALE_SECONDS.
        conn = conductor_db.get_db_connection()
        try:
            conn.execute(
                "UPDATE latest_detections SET updated_at = ? WHERE bus_id = ?",
                ("2020-01-01T00:00:00+00:00", bus_id),
            )
            conn.commit()
        finally:
            conn.close()

        state = self.client.get(
            "/api/conductor/camera-state",
            params={"bus_id": bus_id},
        )
        self.assertEqual(state.status_code, 200)
        body = state.json()
        self.assertEqual(body["count"], 30)          # latest raw detection is still reported
        self.assertTrue(body["stale"])
        self.assertEqual(body["status"], "stale")
        self.assertGreater(body["age_seconds"], body["stale_after_seconds"])

        # Submitting without an explicit snapshot must not attach the stale 30.
        saved = self.submit(bus_id=bus_id, checkpoint="Stale Camera")
        self.assertEqual(saved.status_code, 201)
        data = saved.json()
        self.assertIsNone(data["camera_estimate"])
        self.assertIsNone(data["difference"])
        self.assertIsNone(data["difference_abs"])
        self.assertEqual(data["comparison_status_label"], "Camera unavailable")

    def test_13_fresh_detection_is_used_as_fallback_snapshot(self):
        bus_id = "MH-12-JK-9083"
        conductor_db.record_latest_detection(bus_id, count=41, inference_time_ms=9.5)

        saved = self.submit(
            bus_id=bus_id,
            checkpoint="Fresh Camera",
            active_tickets=35,
            valid_passes=6,
            other_authorized=0,
        )
        self.assertEqual(saved.status_code, 201)
        data = saved.json()
        self.assertEqual(data["camera_estimate"], 41)
        self.assertEqual(data["reported_passengers"], 41)
        self.assertEqual(data["difference"], 0)
        self.assertEqual(data["difference_abs"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
