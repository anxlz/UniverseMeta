"""
Contract tests for the OCR service.

These cover the rules that silently corrupt point totals if broken: null vs zero, unusual
usernames not being mistaken for Streamer Mode, and the winner coming from the score rather
than the side colour.
"""

import unittest

from main import build_response, coerce_player
from schemas import compute_gap, invalid_response, parse_objective_time


class TestObjectiveTime(unittest.TestCase):
    def test_mm_ss_converts_to_seconds(self):
        self.assertEqual(parse_objective_time("01:20"), 80)
        self.assertEqual(parse_objective_time("01:05"), 65)
        self.assertEqual(parse_objective_time("00:49"), 49)
        self.assertEqual(parse_objective_time("01:46"), 106)

    def test_unparseable_stays_none_never_zero(self):
        self.assertIsNone(parse_objective_time("01:75"))
        self.assertIsNone(parse_objective_time("nonsense"))
        self.assertIsNone(parse_objective_time(None))
        self.assertIsNone(parse_objective_time(""))


class TestNullVsZero(unittest.TestCase):
    def test_unknown_and_explicit_zero_stay_distinct(self):
        player = coerce_player(
            {"slot": 1, "rowPresent": True, "name": "x", "kills": None, "assists": 0}, "left", 1
        )
        self.assertIsNone(player.kills)
        self.assertEqual(player.assists, 0)


class TestStreamerMode(unittest.TestCase):
    def test_unusual_usernames_are_not_streamer_mode(self):
        for name in ("_reza1391", "xxALHAJE[7jj]", "J4U+0XmWmEM"):
            player = coerce_player({"slot": 1, "rowPresent": True, "name": name}, "left", 1)
            self.assertEqual(player.identityStatus, "IDENTIFIED", name)

    def test_unreadable_name_is_marked_not_guessed(self):
        player = coerce_player({"slot": 1, "rowPresent": True, "name": None}, "left", 1)
        self.assertEqual(player.identityStatus, "OCR_UNREADABLE")
        self.assertIsNone(player.name)


class TestWinnerDetermination(unittest.TestCase):
    def test_winner_comes_from_score_not_side(self):
        response = build_response(
            {
                "match": {"mode": "hardpoint", "leftScore": 234, "rightScore": 250},
                "teams": {"left": {"players": []}, "right": {"players": []}},
            },
            None,
        )
        self.assertEqual(response.match.leftResult, "loss")
        self.assertEqual(response.match.rightResult, "win")

    def test_never_claims_authority(self):
        response = build_response(
            {
                "match": {"mode": "hardpoint", "leftScore": 250, "rightScore": 240},
                "teams": {"left": {"players": []}, "right": {"players": []}},
            },
            None,
        )
        self.assertFalse(response.teamPointsPreview.authoritative)


class TestGapCalculation(unittest.TestCase):
    def test_reference_scores(self):
        self.assertEqual(compute_gap("hardpoint", 250, 240), (10, 0.04))
        self.assertEqual(compute_gap("search_and_destroy", 9, 3), (6, 0.3))
        self.assertEqual(compute_gap("control", 4, 0), (4, 1.0))

    def test_missing_input_yields_none(self):
        self.assertEqual(compute_gap(None, 1, 2), (None, None))
        self.assertEqual(compute_gap("hardpoint", None, 2), (None, None))


class TestInvalidImage(unittest.TestCase):
    def test_invalid_response_shape(self):
        response = invalid_response(["Image is too blurry"])
        self.assertIsNone(response.match)
        self.assertFalse(response.validation.valid)
        self.assertEqual(response.teams.left.players, [])


if __name__ == "__main__":
    unittest.main()
