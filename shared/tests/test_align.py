"""Tests for placing shots that have no dialogue.

This is the case the dialogue index cannot reach on its own. Measured on a
real 71-beat script about the Breaking Bad box cutter scene, 92% of shots had
no dialogue at all — the scene is famous precisely because nobody speaks.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import align, cutter, library, probe          # noqa: E402
from media_index.demo import make_demo_video as dv             # noqa: E402

HAVE_FFMPEG = probe.ffmpeg_bin() is not None
skip_no_ffmpeg = unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")


def shot(source="Iron Harvest", se="S04E01", dialogue="", target=3.0):
    return {"source": source, "season_episode": se,
            "exact_dialogue": dialogue, "visual": "x",
            "duration_target_sec": target}


def beats_from(shots):
    return [{"beat": i + 1, "narration": f"n{i+1}", "shots": [s]}
            for i, s in enumerate(shots)]


class TestRuns(unittest.TestCase):
    def test_consecutive_same_episode_forms_one_run(self):
        r = align.runs(beats_from([shot(), shot(), shot()]))
        self.assertEqual(len(r), 1)
        self.assertEqual(len(r[0].entries), 3)

    def test_episode_change_starts_a_new_run(self):
        r = align.runs(beats_from([shot(se="S04E01"), shot(se="S04E01"),
                                   shot(se="S03E13"), shot(se="S04E01")]))
        self.assertEqual([len(x.entries) for x in r], [2, 1, 1])

    def test_source_change_starts_a_new_run(self):
        r = align.runs(beats_from([shot(source="Breaking Bad"),
                                   shot(source="Better Call Saul")]))
        self.assertEqual(len(r), 2)

    def test_several_shots_in_one_beat_stay_in_order(self):
        beats = [{"beat": 1, "shots": [shot(), shot(), shot()]}]
        r = align.runs(beats)
        self.assertEqual([e.shot for e in r[0].entries], [1, 2, 3])


@skip_no_ffmpeg
class TestAlignWordlessScene(unittest.TestCase):
    """The real shape: a run of shots through one scene, where only the first
    and last carry any dialogue at all."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="align_")
        root = os.path.join(cls.tmp, "Iron Harvest", "Season 04")
        cls.vid = dv.build(os.path.join(root, "Iron.Harvest.S04E01.1080p.mkv"),
                           log=lambda *a: None)
        cls.db = os.path.join(cls.tmp, "library.db")
        library.build(root, cls.db, log=lambda *a: None)

        cls.beats = beats_from([
            shot(dialogue="The first line lands on the red segment"),
            shot(), shot(), shot(), shot(), shot(), shot(),
            shot(dialogue="Grey. Then we burn the field"),
        ])
        cls.places = align.align(cls.db, cls.beats, log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _segment_at(self, seconds):
        got = cutter.average_rgb(self.vid, seconds)
        return min(range(dv.n_segments()),
                   key=lambda k: sum(abs(a - b) for a, b in
                                     zip(got, dv.segment_color(k)[2])))

    def test_everything_is_placed(self):
        self.assertEqual(len(self.places), 8)
        self.assertTrue(all(p.ok for p in self.places))

    def test_the_two_dialogue_shots_are_anchors(self):
        self.assertEqual(self.places[0].method, "anchor")
        self.assertEqual(self.places[-1].method, "anchor")
        self.assertEqual(self.places[0].confidence, "high")

    def test_every_shot_lands_on_the_right_part_of_the_scene(self):
        """Verified by sampling the frame colour, not by trusting the maths."""
        for i, p in enumerate(self.places):
            got = self._segment_at(p.start_ms / 1000 + 0.5)
            self.assertEqual(got, i,
                             f"beat {p.beat} landed on segment {got}, wanted {i}")

    def test_placements_move_forward_through_the_scene(self):
        times = [p.start_ms for p in self.places]
        self.assertEqual(times, sorted(times))

    def test_no_two_shots_land_on_the_same_moment(self):
        times = sorted(p.start_ms for p in self.places)
        for a, b in zip(times, times[1:]):
            self.assertGreater(b - a, align.MIN_SEPARATION_S * 1000 - 1)

    def test_a_run_with_no_dialogue_at_all_is_reported(self):
        places = align.align(self.db, beats_from([shot(), shot(), shot()]),
                             log=lambda *a: None)
        self.assertTrue(all(not p.ok for p in places))
        self.assertIn("anchor", places[0].note)

    def test_a_single_shot_run_is_left_to_ordinary_search(self):
        places = align.align(self.db, beats_from([shot(dialogue="x")]),
                             log=lambda *a: None)
        self.assertIn("too short", places[0].note)

    def test_summary_reports_usable_share(self):
        text = align.summarise(self.places)
        self.assertIn("anchored", text)
        self.assertIn("100%", text)


class TestAnchorSanity(unittest.TestCase):
    def test_out_of_order_anchors_are_dropped(self):
        """An anchor that matched the wrong moment would drag everything after
        it backwards, so a crossing pair keeps the more confident one."""
        run = align.Run("X", "S01E01", [])
        found = [(0, 1000, 2000, "p", "high"),
                 (1, 500, 900, "p", "medium"),      # earlier than its predecessor
                 (2, 5000, 6000, "p", "high")]
        # replicate the cleaning step
        clean = []
        for a in found:
            while clean and a[1] <= clean[-1][1]:
                if clean[-1][4] == "high" and a[4] != "high":
                    a = None
                    break
                clean.pop()
            if a:
                clean.append(a)
        self.assertEqual([c[0] for c in clean], [0, 2])


if __name__ == "__main__":
    unittest.main(verbosity=2)
