"""
Standalone Conductor Database & Checkpoint Persistence Test Suite
Uses ONLY Python Standard Library (unittest, sqlite3, os, datetime)
Tests the actual SQLite database persistence, constraints, calculations, and history preservation.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backend import conductor_db


class TestConductorDbPersistence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conductor_db.init_db()

    def test_01_registered_buses(self):
        """Verify registered fleet buses populate correctly."""
        buses = conductor_db.get_registered_buses()
        self.assertGreaterEqual(len(buses), 1)
        ids = [b["id"] for b in buses]
        self.assertIn("MH-12-QW-4821", ids)

    def test_02_checkpoint_persistence_and_calculations(self):
        """Test checkpoint saving, reported passenger total, and expected onboard calculation."""
        bus_id = "MH-12-QW-4821"
        route = "Pune – Mumbai"
        trip_id = "TRIP-AUTO-01"
        checkpoint = "Lonavala Bus Stand"

        # Record a test detection in SQLite first
        conductor_db.record_latest_detection(bus_id, count=46, inference_time_ms=15.2)

        saved = conductor_db.save_checkpoint_submission(
            bus_id=bus_id,
            route=route,
            trip_id=trip_id,
            checkpoint=checkpoint,
            conductor_id="A. Jadhav",
            active_tickets=39,
            valid_passes=5,
            other_authorized=2,      # reported = 39 + 5 + 2 = 46
            starting_onboard=40,
            boarded=9,
            alighted=3,              # expected = 40 + 9 - 3 = 46
            notes="Smooth transit through Lonavala"
        )

        self.assertIsNotNone(saved["id"])
        self.assertEqual(saved["reported_passengers"], 46)
        self.assertEqual(saved["expected_onboard"], 46)
        self.assertEqual(saved["camera_estimate"], 46)
        self.assertEqual(saved["difference"], 0)
        self.assertEqual(saved["comparison_status"], "Match")

        # Verify record survives in database
        latest = conductor_db.get_latest_checkpoint(bus_id, trip_id)
        self.assertIsNotNone(latest)
        self.assertEqual(latest["id"], saved["id"])
        self.assertEqual(latest["checkpoint"], checkpoint)
        self.assertEqual(latest["expected_onboard"], 46)

    def test_03_multiple_checkpoints_preserved_without_overwriting(self):
        """Test sequential checkpoints for the same trip are all preserved in history."""
        bus_id = "MH-14-BT-1906"
        route = "Pune – Nashik"
        trip_id = "TRIP-NASHIK-99"

        # Checkpoint 1
        c1 = conductor_db.save_checkpoint_submission(
            bus_id=bus_id, route=route, trip_id=trip_id, checkpoint="Shivajinagar Depot",
            active_tickets=30, valid_passes=5, starting_onboard=0, boarded=35, alighted=0
        )
        # Checkpoint 2
        c2 = conductor_db.save_checkpoint_submission(
            bus_id=bus_id, route=route, trip_id=trip_id, checkpoint="Alephata Bypass",
            active_tickets=33, valid_passes=6, starting_onboard=35, boarded=4, alighted=0
        )
        # Checkpoint 3
        c3 = conductor_db.save_checkpoint_submission(
            bus_id=bus_id, route=route, trip_id=trip_id, checkpoint="Sangamner Stand",
            active_tickets=30, valid_passes=6, starting_onboard=39, boarded=2, alighted=5
        )

        self.assertNotEqual(c1["id"], c2["id"])
        self.assertNotEqual(c2["id"], c3["id"])

        # Fetch history
        history = conductor_db.get_checkpoint_history(bus_id=bus_id, trip_id=trip_id)
        self.assertGreaterEqual(len(history), 3)

        # Confirm newest is first
        self.assertEqual(history[0]["checkpoint"], "Sangamner Stand")
        self.assertEqual(history[1]["checkpoint"], "Alephata Bypass")
        self.assertEqual(history[2]["checkpoint"], "Shivajinagar Depot")

    def test_04_validation_rejects_negative_movement(self):
        """Verify starting + boarded - alighted < 0 raises ValueError."""
        with self.assertRaises(ValueError):
            conductor_db.save_checkpoint_submission(
                bus_id="MH-12-QW-4821", route="Pune – Mumbai", trip_id="TRIP-ERR",
                checkpoint="Test Stand", active_tickets=20, valid_passes=5,
                starting_onboard=5, boarded=1, alighted=10  # 5 + 1 - 10 = -4 < 0
            )

    def test_05_validation_rejects_negative_and_excessive_counts(self):
        """Verify negative counts and counts > 500 are rejected."""
        with self.assertRaises(ValueError):
            conductor_db.save_checkpoint_submission(
                bus_id="MH-12-QW-4821", route="Pune – Mumbai", trip_id="TRIP-ERR",
                checkpoint="Test Stand", active_tickets=-5, valid_passes=5, starting_onboard=10
            )

        with self.assertRaises(ValueError):
            conductor_db.save_checkpoint_submission(
                bus_id="MH-12-QW-4821", route="Pune – Mumbai", trip_id="TRIP-ERR",
                checkpoint="Test Stand", active_tickets=20, valid_passes=5, starting_onboard=600
            )

    def test_06_discrepancy_signed_calculation(self):
        """Verify difference = reported_passengers - camera_estimate (signed)."""
        bus_id = "MH-09-CV-3372"
        route = "Pune – Kolhapur"
        trip_id = "TRIP-KOLHAPUR-01"

        # Camera count: 50
        conductor_db.record_latest_detection(bus_id, count=50)

        # Reported: 47 (42 tickets + 5 passes); expected: 47 (40 + 10 - 3)
        res = conductor_db.save_checkpoint_submission(
            bus_id=bus_id, route=route, trip_id=trip_id, checkpoint="Karad Stand",
            active_tickets=42, valid_passes=5, starting_onboard=40, boarded=10, alighted=3
        )
        self.assertEqual(res["reported_passengers"], 47)
        self.assertEqual(res["difference"], -3)  # 47 - 50 = -3
        self.assertEqual(res["difference_abs"], 3)
        self.assertEqual(res["comparison_status"], "Discrepancy — verify")
        self.assertEqual(res["comparison_status_label"], "Mismatch: 3 passengers")

        # Camera count: 44
        conductor_db.record_latest_detection(bus_id, count=44)
        res2 = conductor_db.save_checkpoint_submission(
            bus_id=bus_id, route=route, trip_id=trip_id, checkpoint="Satara Bypass",
            active_tickets=42, valid_passes=5, starting_onboard=40, boarded=10, alighted=3
        )
        self.assertEqual(res2["difference"], 3)  # 47 - 44 = +3
        self.assertEqual(res2["difference_abs"], 3)
        self.assertEqual(res2["comparison_status"], "Discrepancy — verify")
        self.assertEqual(res2["comparison_status_label"], "Mismatch: 3 passengers")

    def test_07_get_checkpoint_by_id(self):
        """Verify retrieving a specific checkpoint submission by its primary key ID."""
        saved = conductor_db.save_checkpoint_submission(
            bus_id="MH-12-QW-4821",
            route="Pune – Mumbai",
            trip_id="TRIP-PK-01",
            checkpoint="Khopoli Toll",
            active_tickets=25,
            valid_passes=5,
            starting_onboard=20,
            boarded=10,
            alighted=0
        )
        rec_id = saved["id"]
        fetched = conductor_db.get_checkpoint_by_id(rec_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched["id"], rec_id)
        self.assertEqual(fetched["checkpoint"], "Khopoli Toll")
        self.assertEqual(fetched["expected_onboard"], 30)

        # Non-existent ID returns None
        self.assertIsNone(conductor_db.get_checkpoint_by_id(99999999))


if __name__ == "__main__":
    unittest.main()

