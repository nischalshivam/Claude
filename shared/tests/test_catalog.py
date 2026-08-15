"""Index a whole title into a searchable, tagged shot library — offline."""
import json
import os
import shutil
import tempfile
import unittest

from media_index import catalog


class Cue:
    def __init__(self, start_ms, end_ms, text):
        self.start_ms, self.end_ms, self.text = start_ms, end_ms, text


class TestSegmentation(unittest.TestCase):

    def test_cuts_become_windows_and_long_takes_are_split(self):
        # a 35s middle take (and the 12s first take) must not ship whole
        got = catalog.shots_from_cuts([12.0, 47.0], 60.0)
        self.assertTrue(all(b - a <= catalog.MAX_SHOT_S + 1e-6 for a, b in got))
        # a real cut point is always preserved as a window boundary
        boundaries = {a for a, _b in got} | {b for _a, b in got}
        self.assertIn(12.0, boundaries)
        self.assertIn(47.0, boundaries)
        # windows tile the whole duration with no gaps
        self.assertAlmostEqual(got[0][0], 0.0)
        self.assertAlmostEqual(got[-1][1], 60.0)
        for (a1, b1), (a2, b2) in zip(got, got[1:]):
            self.assertAlmostEqual(b1, a2)

    def test_a_sliver_is_folded_into_the_previous_shot(self):
        got = catalog.shots_from_cuts([10.0, 10.3], 20.0)   # 0.3s sliver
        self.assertTrue(all(b - a >= catalog.MIN_SHOT_S for a, b in got))

    def test_fixed_windows_tile_the_duration(self):
        got = catalog.fixed_windows(13.0, win_s=5.0)
        self.assertEqual(got, [(0.0, 5.0), (5.0, 10.0), (10.0, 13.0)])

    def test_zero_duration_is_no_shots(self):
        self.assertEqual(catalog.shots_from_cuts([], 0), [])
        self.assertEqual(catalog.fixed_windows(0), [])


class TestDialogueOverlap(unittest.TestCase):

    def test_only_overlapping_cues_are_attached(self):
        cues = [Cue(1000, 3000, "before"), Cue(4000, 6000, "inside"),
                Cue(9000, 9500, "after")]
        self.assertEqual(catalog.dialogue_for(cues, 3.5, 7.0), "inside")


class TestParseTags(unittest.TestCase):

    def test_a_clean_answer_parses(self):
        out = catalog.parse_tags(json.dumps({
            "description": "Arthur alone in a dim room",
            "tags": ["Arthur", "DIM", "alone"], "characters": ["Arthur"],
            "action": "sits", "shot_type": "Close-Up", "quality": "High",
            "safe": True}))
        self.assertEqual(out["characters"], ["Arthur"])
        self.assertEqual(out["tags"], ["arthur", "dim", "alone"])
        self.assertEqual(out["shot_type"], "close-up")
        self.assertEqual(out["quality"], "high")

    def test_unknown_is_never_stored_as_a_character(self):
        out = catalog.parse_tags(json.dumps(
            {"description": "a crowd", "characters": ["unknown", "none"]}))
        self.assertEqual(out["characters"], [])

    def test_fenced_or_junky_answer_is_survived(self):
        text = "```json\n{\"description\": \"x\", \"safe\": false}\n```"
        out = catalog.parse_tags(text)
        self.assertEqual(out["description"], "x")
        self.assertFalse(out["safe"])

    def test_garbage_is_an_empty_dict_not_a_crash(self):
        self.assertEqual(catalog.parse_tags("no json here"), {})


class TestBuildCatalog(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cat_")
        self.out = os.path.join(self.tmp, "catalog.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fake_ask(self, calls):
        def ask(messages):
            calls.append(1)
            return json.dumps({"description": "a man in a room",
                               "tags": ["man", "room"], "characters": ["Arthur"],
                               "action": "stands", "shot_type": "medium",
                               "quality": "high", "safe": True})
        return ask

    def test_every_window_becomes_a_saved_shot(self):
        calls = []
        lib = catalog.build_catalog(
            "Joker (2019)", "/movies/joker.mp4", duration=15.0,
            out_json=self.out, grab=lambda a, b: [b"jpeg"],
            ask=self._fake_ask(calls), windows=catalog.fixed_windows(15.0, 5.0))
        self.assertEqual(len(lib), 3)
        self.assertEqual(len(calls), 3)
        # persisted, and readable back
        on_disk = catalog.load_library(self.out)
        self.assertEqual(len(on_disk), 3)
        self.assertEqual(next(iter(on_disk.values())).source, "Joker (2019)")

    def test_a_resumed_run_does_not_re_tag_done_shots(self):
        windows = catalog.fixed_windows(15.0, 5.0)
        first = []
        catalog.build_catalog("J", "/j.mp4", 15.0, self.out,
                              lambda a, b: [b"x"], self._fake_ask(first),
                              windows=windows)
        self.assertEqual(len(first), 3)
        second = []            # same out file → everything already described
        catalog.build_catalog("J", "/j.mp4", 15.0, self.out,
                              lambda a, b: [b"x"], self._fake_ask(second),
                              windows=windows)
        self.assertEqual(second, [])          # nothing re-asked

    def test_a_grab_that_fails_still_records_the_shot(self):
        def bad_grab(a, b):
            raise RuntimeError("ffmpeg fell over")
        lib = catalog.build_catalog(
            "J", "/j.mp4", 5.0, self.out, bad_grab, self._fake_ask([]),
            windows=[(0.0, 5.0)])
        self.assertEqual(len(lib), 1)          # a blank entry, not a crash
        self.assertEqual(next(iter(lib.values())).description, "")

    def test_dialogue_is_attached_from_cues(self):
        cues = [Cue(1000, 4000, "Is it just me?")]
        lib = catalog.build_catalog(
            "J", "/j.mp4", 5.0, self.out, lambda a, b: [b"x"],
            self._fake_ask([]), cues=cues, windows=[(0.0, 5.0)])
        self.assertIn("Is it just me?", next(iter(lib.values())).dialogue)


class TestSearch(unittest.TestCase):

    def _lib(self):
        return {
            "s1": catalog.Shot("s1", "J", "/j.mp4", 0, 5,
                               description="Arthur dances alone in a dim bathroom",
                               tags=["dance", "bathroom", "alone", "dim"],
                               characters=["Arthur"], quality="high"),
            "s2": catalog.Shot("s2", "J", "/j.mp4", 5, 10,
                               description="Murray on a bright talk show stage",
                               tags=["stage", "talk show", "bright"],
                               characters=["Murray"], quality="high"),
            "s3": catalog.Shot("s3", "J", "/j.mp4", 10, 15,
                               description="a caption-covered recap frame",
                               tags=["text"], characters=[], quality="high",
                               safe=False),
        }

    def test_meaning_query_finds_the_right_shot(self):
        got = catalog.search(self._lib(), "the bathroom dance scene")
        self.assertEqual(got[0].id, "s1")

    def test_character_filter_is_decisive(self):
        got = catalog.search(self._lib(), "on stage", character="Murray")
        self.assertEqual(got[0].id, "s2")

    def test_unsafe_shots_are_excluded(self):
        got = catalog.search(self._lib(), "text recap")
        self.assertTrue(all(s.id != "s3" for s in got))


if __name__ == "__main__":
    unittest.main()
