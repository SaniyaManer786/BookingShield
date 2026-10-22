"""
SMART ST Control Center - Automated Conductor Panel & CV Integration Test Suite
Validates database persistence, input validation, API endpoints, and camera-conductor cross-verification.
"""

import sys
import os
import unittest
import base64
import json

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend import conductor_db
from backend.main import app
from fastapi.testclient import TestClient


class TestConductorPanelSystem(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Initialize DB
        conductor_db.init_db()
        cls.client = TestClient(app)

    def test_01_registered_buses(self):
        """Verify registered fleet buses can be retrieved."""
        buses = conductor_db.get_registered_buses()
        self.assertGreaterEqual(len(buses), 1)
        bus_ids = [b["id"] for b in buses]
        self.assertIn("MH-12-QW-4821", bus_ids)

        # Test API endpoint
        resp = self.client.get("/api/conductor/buses")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["success"])
        self.assertGreaterEqual(len(data["buses"]), 1)

    def test_02_save_and_retrieve_conductor_counts(self):
        """Test saving conductor passenger accounting and retrieving persisted record."""
        bus_id = "MH-12-QW-4821"
        trip_id = "TEST-TRIP-01"

        saved = conductor_db.save_conductor_counts(
            bus_id=bus_id,
            trip_id=trip_id,
            active_tickets=35,
            valid_passes=7,
            notes="Testing unit persistence",
            conductor_name="A. Jadhav"
        )
        self.assertEqual(saved["active_tickets"], 35)
        self.assertEqual(saved["valid_passes"], 7)
        self.assertEqual(saved["total_reported"], 42)  # 35 + 7 = 42

        # Verify retrieval from SQLite
        record = conductor_db.get_conductor_counts(bus_id, trip_id)
        self.assertIsNotNone(record)
        self.assertEqual(record["total_reported"], 42)
        self.assertEqual(record["notes"], "Testing unit persistence")

        # Verify API endpoint
        resp = self.client.get(f"/api/conductor/counts?bus_id={bus_id}&trip_id={trip_id}")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["total_reported"], 42)

    def test_03_update_existing_record(self):
        """Test updating an existing conductor record for the same trip (idempotency/upsert)."""
        bus_id = "MH-12-QW-4821"
        trip_id = "TEST-TRIP-01"

        # Update with new counts
        payload = {
            "bus_id": bus_id,
            "trip_id": trip_id,
            "active_tickets": 40,
            "valid_passes": 8,
            "notes": "Updated at next depot",
            "conductor_name": "A. Jadhav"
        }
        resp = self.client.post("/api/conductor/counts", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["active_tickets"], 40)
        self.assertEqual(data["valid_passes"], 8)
        self.assertEqual(data["total_reported"], 48)  # 40 + 8

        # Verify single unique record in database
        conn = conductor_db.get_db_connection()
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM conductor_records WHERE bus_id = ? AND trip_id = ?", (bus_id, trip_id))
        count = c.fetchone()[0]
        conn.close()
        self.assertEqual(count, 1)

    def test_04_validation_rejections(self):
        """Test validation rules: reject negative, fractional, and empty values."""
        # Negative active tickets
        bad_payload_neg = {
            "bus_id": "MH-12-QW-4821",
            "trip_id": "TEST-TRIP-02",
            "active_tickets": -5,
            "valid_passes": 4
        }
        resp = self.client.post("/api/conductor/counts", json=bad_payload_neg)
        self.assertIn(resp.status_code, [400, 422])

        # Negative valid passes
        bad_payload_neg2 = {
            "bus_id": "MH-12-QW-4821",
            "trip_id": "TEST-TRIP-02",
            "active_tickets": 20,
            "valid_passes": -1
        }
        resp = self.client.post("/api/conductor/counts", json=bad_payload_neg2)
        self.assertIn(resp.status_code, [400, 422])

        # Empty bus_id
        bad_payload_empty_bus = {
            "bus_id": "   ",
            "trip_id": "TEST-TRIP-02",
            "active_tickets": 20,
            "valid_passes": 5
        }
        resp = self.client.post("/api/conductor/counts", json=bad_payload_empty_bus)
        self.assertIn(resp.status_code, [400, 422])

        # Direct DB ValueError test
        with self.assertRaises(ValueError):
            conductor_db.save_conductor_counts("MH-12-QW-4821", "TRIP-01", -10, 5)

        with self.assertRaises(ValueError):
            conductor_db.save_conductor_counts("", "TRIP-01", 10, 5)

    def test_05_camera_detection_and_comparison(self):
        """Test CV detection recording and discrepancy verification calculation."""
        bus_id = "MH-14-BT-1906"
        trip_id = "TRIP-0871-02"

        # Conductor reports 38 tickets and 2 passes (Total: 40)
        conductor_db.save_conductor_counts(bus_id, trip_id, active_tickets=38, valid_passes=2)

        # Scenario A: Camera detects 40 people -> Exact match (Difference = 0)
        conductor_db.record_latest_detection(bus_id, count=40, inference_time_ms=18.5)
        comp_a = conductor_db.get_comparison(bus_id, trip_id)
        self.assertEqual(comp_a["detected_count"], 40)
        self.assertEqual(comp_a["total_reported"], 40)
        self.assertEqual(comp_a["difference"], 0)
        self.assertFalse(comp_a["has_mismatch"])
        self.assertEqual(comp_a["status_category"], "normal")

        # Scenario B: Camera detects 43 people -> Discrepancy +3 (Difference = 43 - 40 = 3)
        conductor_db.record_latest_detection(bus_id, count=43, inference_time_ms=19.2)
        comp_b = conductor_db.get_comparison(bus_id, trip_id)
        self.assertEqual(comp_b["detected_count"], 43)
        self.assertEqual(comp_b["difference"], 3)
        self.assertTrue(comp_b["has_mismatch"])
        self.assertEqual(comp_b["status_category"], "mismatch")

        # Scenario C: Camera detects 37 people -> Discrepancy -3 (Difference = 37 - 40 = -3)
        conductor_db.record_latest_detection(bus_id, count=37, inference_time_ms=17.8)
        comp_c = conductor_db.get_comparison(bus_id, trip_id)
        self.assertEqual(comp_c["detected_count"], 37)
        self.assertEqual(comp_c["difference"], -3)
        self.assertTrue(comp_c["has_mismatch"])
        self.assertEqual(comp_c["status_category"], "reviewed")

        # Test Comparison API endpoint
        resp = self.client.get(f"/api/conductor/comparison?bus_id={bus_id}&trip_id={trip_id}")
        self.assertEqual(resp.status_code, 200)
        api_data = resp.json()
        self.assertTrue(api_data["success"])
        self.assertEqual(api_data["detected_count"], 37)
        self.assertEqual(api_data["difference"], -3)

    def test_06_yolo_detect_integration(self):
        """Test real backend detection endpoint /api/detect updates latest detection for the bus."""
        # Get sample frame from existing endpoint
        sample_resp = self.client.get("/api/sample-frame")
        self.assertEqual(sample_resp.status_code, 200)
        sample_img = sample_resp.json()["image"]

        target_bus = "MH-09-CV-3372"

        # Post detection request with bus_id
        det_resp = self.client.post("/api/detect", json={
            "image": sample_img,
            "track": False,
            "bus_id": target_bus
        })
        self.assertEqual(det_resp.status_code, 200)
        det_data = det_resp.json()
        self.assertTrue(det_data["success"])
        detected_people_count = det_data["count"]

        # Check latest-detection endpoint
        latest_resp = self.client.get(f"/api/conductor/latest-detection?bus_id={target_bus}")
        self.assertEqual(latest_resp.status_code, 200)
        latest_data = latest_resp.json()
        self.assertTrue(latest_data["success"])
        self.assertEqual(latest_data["detected_count"], detected_people_count)

    def test_07_checkpoint_submission_and_persistence(self):
        """Test checkpoint submission persists correctly with passenger movement and camera snapshot."""
        bus_id = "MH-12-QW-4821"
        trip_id = "TRIP-1042-01"
        route = "Pune – Mumbai"
        checkpoint = "Lonavala Bus Stand"

        # Pre-set camera detection to 45
        conductor_db.record_latest_detection(bus_id, count=45, inference_time_ms=16.4)

        payload = {
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "checkpoint": checkpoint,
            "conductor_id": "A. Jadhav",
            "active_tickets": 38,
            "valid_passes": 5,
            "other_authorized": 2,      # reported = 38 + 5 + 2 = 45
            "starting_onboard": 40,
            "boarded": 8,
            "alighted": 3,              # expected = 40 + 8 - 3 = 45
            "notes": "Smooth boarding at Lonavala"
        }

        resp = self.client.post("/api/conductor/checkpoint", json=payload)
        self.assertEqual(resp.status_code, 201)
        data = resp.json()
        self.assertTrue(data["success"])
        self.assertGreater(data["id"], 0)
        self.assertEqual(data["reported_passengers"], 45)
        self.assertEqual(data["expected_onboard"], 45)
        self.assertEqual(data["camera_estimate"], 45)
        self.assertEqual(data["difference"], 0)
        self.assertEqual(data["comparison_status"], "Match")
        self.assertEqual(data["checkpoint"], "Lonavala Bus Stand")

        # Verify retrieval via direct database query
        conn = conductor_db.get_db_connection()
        c = conn.cursor()
        c.execute("SELECT * FROM checkpoint_submissions WHERE id = ?", (data["id"],))
        row = dict(c.fetchone())
        conn.close()

        self.assertEqual(row["checkpoint"], checkpoint)
        self.assertEqual(row["expected_onboard"], 45)
        self.assertEqual(row["reported_passengers"], 45)
        self.assertEqual(row["camera_estimate"], 45)
        self.assertEqual(row["difference"], 0)

    def test_08_multiple_checkpoints_without_overwriting(self):
        """Verify multiple checkpoint submissions during a single trip create separate historical records."""
        bus_id = "MH-12-QW-4821"
        trip_id = "TRIP-SEQ-99"
        route = "Pune – Mumbai"

        # Checkpoint 1: Swargate Depot
        p1 = {
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "checkpoint": "Swargate Depot",
            "active_tickets": 30,
            "valid_passes": 5,
            "other_authorized": 0,
            "starting_onboard": 0,
            "boarded": 35,
            "alighted": 0,
            "notes": "Trip start"
        }
        r1 = self.client.post("/api/conductor/checkpoint", json=p1)
        self.assertEqual(r1.status_code, 201)
        id1 = r1.json()["id"]

        # Checkpoint 2: Katraj Tunnel
        p2 = {
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "checkpoint": "Katraj Tunnel",
            "active_tickets": 35,
            "valid_passes": 6,
            "other_authorized": 1,
            "starting_onboard": 35,
            "boarded": 7,
            "alighted": 0,
            "notes": "Added en-route passengers"
        }
        r2 = self.client.post("/api/conductor/checkpoint", json=p2)
        self.assertEqual(r2.status_code, 201)
        id2 = r2.json()["id"]

        # Checkpoint 3: Lonavala Bus Stand
        p3 = {
            "bus_id": bus_id,
            "route": route,
            "trip_id": trip_id,
            "checkpoint": "Lonavala Bus Stand",
            "active_tickets": 32,
            "valid_passes": 6,
            "other_authorized": 1,
            "starting_onboard": 42,
            "boarded": 2,
            "alighted": 5,
            "notes": "Mid-point checkpoint"
        }
        r3 = self.client.post("/api/conductor/checkpoint", json=p3)
        self.assertEqual(r3.status_code, 201)
        id3 = r3.json()["id"]

        # Check all 3 distinct IDs exist
        self.assertNotEqual(id1, id2)
        self.assertNotEqual(id2, id3)

        # Retrieve history via API
        h_resp = self.client.get(f"/api/conductor/checkpoints?bus_id={bus_id}&trip_id={trip_id}")
        self.assertEqual(h_resp.status_code, 200)
        h_data = h_resp.json()
        self.assertTrue(h_data["success"])
        self.assertGreaterEqual(h_data["count"], 3)

        checkpoints = [c["checkpoint"] for c in h_data["checkpoints"]]
        # Ordered newest first
        self.assertEqual(checkpoints[0], "Lonavala Bus Stand")
        self.assertEqual(checkpoints[1], "Katraj Tunnel")
        self.assertEqual(checkpoints[2], "Swargate Depot")

    def test_09_checkpoint_validation_rules(self):
        """Verify strict rejection of negative counts and invalid passenger movement."""
        # 1. Invalid movement producing negative expected occupancy (5 + 1 - 10 = -4)
        bad_movement = {
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-VAL-01",
            "checkpoint": "Khandala Ghat",
            "active_tickets": 20,
            "valid_passes": 5,
            "starting_onboard": 5,
            "boarded": 1,
            "alighted": 10
        }
        resp = self.client.post("/api/conductor/checkpoint", json=bad_movement)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("negative expected occupancy", resp.json()["detail"])

        # 2. Negative active tickets
        bad_negative = {
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-VAL-01",
            "checkpoint": "Khandala Ghat",
            "active_tickets": -3,
            "valid_passes": 5,
            "starting_onboard": 10
        }
        resp = self.client.post("/api/conductor/checkpoint", json=bad_negative)
        self.assertIn(resp.status_code, [400, 422])

        # 3. Missing required checkpoint name
        bad_missing_cp = {
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-VAL-01",
            "checkpoint": "   ",
            "active_tickets": 20,
            "valid_passes": 5,
            "starting_onboard": 10
        }
        resp = self.client.post("/api/conductor/checkpoint", json=bad_missing_cp)
        self.assertEqual(resp.status_code, 400)

    def test_10_latest_checkpoint_endpoint(self):
        """Verify retrieval of latest checkpoint."""
        bus_id = "MH-12-QW-4821"
        trip_id = "TRIP-SEQ-99"

        resp = self.client.get(f"/api/conductor/checkpoint/latest?bus_id={bus_id}&trip_id={trip_id}")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["success"])
        self.assertIsNotNone(data["checkpoint"])
        self.assertEqual(data["checkpoint"]["checkpoint"], "Lonavala Bus Stand")

    def test_11_fractional_and_non_numeric_validation(self):
        """Verify fractional and non-numeric counts are strictly rejected."""
        # Fractional active_tickets
        bad_fraction = {
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-VAL-02",
            "checkpoint": "Khandala Ghat",
            "active_tickets": 20.5,
            "valid_passes": 5,
            "starting_onboard": 10
        }
        resp = self.client.post("/api/conductor/checkpoints", json=bad_fraction)
        self.assertIn(resp.status_code, [400, 422])

        # Non-numeric string for valid_passes
        bad_non_numeric = {
            "bus_id": "MH-12-QW-4821",
            "route": "Pune – Mumbai",
            "trip_id": "TRIP-VAL-02",
            "checkpoint": "Khandala Ghat",
            "active_tickets": 20,
            "valid_passes": "five",
            "starting_onboard": 10
        }
        resp = self.client.post("/api/conductor/checkpoints", json=bad_non_numeric)
        self.assertIn(resp.status_code, [400, 422])

    def test_12_plural_checkpoints_endpoint_and_query_aliases(self):
        """Verify POST /api/conductor/checkpoints and GET with bus / tripId query aliases."""
        bus_id = "MH-11-AX-2208"
        trip_id = "TRIP-0955-99"
        payload = {
            "bus_id": bus_id,
            "route": "Pune – Solapur",
            "trip_id": trip_id,
            "checkpoint": "Indapur Stand",
            "active_tickets": 28,
            "valid_passes": 4,
            "other_authorized": 0,
            "starting_onboard": 30,
            "boarded": 5,
            "alighted": 3
        }
        # Test plural POST endpoint
        post_resp = self.client.post("/api/conductor/checkpoints", json=payload)
        self.assertEqual(post_resp.status_code, 201)
        data = post_resp.json()
        rec_id = data["id"]
        self.assertEqual(data["expected_onboard"], 32)

        # Test query aliases: bus and tripId
        history_resp = self.client.get(f"/api/conductor/checkpoints?bus={bus_id}&tripId={trip_id}")
        self.assertEqual(history_resp.status_code, 200)
        h_data = history_resp.json()
        self.assertTrue(h_data["success"])
        self.assertGreaterEqual(h_data["count"], 1)

        # Test latest checkpoint with bus and tripId aliases
        latest_resp = self.client.get(f"/api/conductor/checkpoints/latest?bus={bus_id}&tripId={trip_id}")
        self.assertEqual(latest_resp.status_code, 200)
        l_data = latest_resp.json()
        self.assertTrue(l_data["success"])
        self.assertEqual(l_data["checkpoint"]["id"], rec_id)

    def test_13_get_checkpoint_by_id_endpoint(self):
        """Verify GET /api/conductor/checkpoints/{id} retrieves saved record."""
        # Create a new checkpoint
        payload = {
            "bus_id": "MH-01-CD-7834",
            "route": "Mumbai – Nashik",
            "trip_id": "TRIP-1320-IDTEST",
            "checkpoint": "Kasara Ghat",
            "active_tickets": 22,
            "valid_passes": 3,
            "starting_onboard": 25,
            "boarded": 0,
            "alighted": 0
        }
        res = self.client.post("/api/conductor/checkpoints", json=payload)
        self.assertEqual(res.status_code, 201)
        rec_id = res.json()["id"]

        # Retrieve by ID
        get_res = self.client.get(f"/api/conductor/checkpoints/{rec_id}")
        self.assertEqual(get_res.status_code, 200)
        fetched = get_res.json()["checkpoint"]
        self.assertEqual(fetched["id"], rec_id)
        self.assertEqual(fetched["checkpoint"], "Kasara Ghat")

        # 404 for non-existent ID
        not_found = self.client.get("/api/conductor/checkpoints/99999999")
        self.assertEqual(not_found.status_code, 404)


if __name__ == "__main__":
    unittest.main()


