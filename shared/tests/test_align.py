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

    def test_a_cutaway_does_not_split_the_run(self):
        """The shots either side of a cutaway are still the same walk.

        Splitting on every interruption used to leave the third S04E01 shot
        alone in a run of one, and a lone silent shot has no anchor and
        cannot be placed at all. On the real 106-shot script that produced
        36 runs, 23 of them single shots — so the cutaways were not just
        fragmenting the walk, they were deleting shots from the video.
        """
        r = align.runs(beats_from([shot(se="S04E01"), shot(se="S04E01"),
                                   shot(se="S03E13"), shot(se="S04E01")]))
        self.assertEqual([len(x.entries) for x in r], [3, 1])
        self.assertEqual(r[0].season_episode, "S04E01")
        self.assertEqual([e.beat for e in r[0].entries], [1, 2, 4])

    def test_a_different_episode_is_a_different_run(self):
        r = align.runs(beats_from([shot(se="S04E01"), shot(se="S03E13")]))
        self.assertEqual(len(r), 2)
        self.assertEqual({x.season_episode for x in r}, {"S04E01", "S03E13"})

    def test_runs_keep_the_order_they_first_appear_in(self):
        r = align.runs(beats_from([shot(se="S04E13"), shot(se="S01E01"),
                                   shot(se="S04E13")]))
        self.assertEqual([x.season_episode for x in r], ["S04E13", "S01E01"])

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
        it backwards, so a crossing one is left out.

        Asserted against the real function. This used to re-implement the
        cleaning inline, which meant it went on passing after the cleaning
        itself was replaced — a test of a copy is a test of nothing.
        """
        found = [(0, 1000, 2000, "p", "high"),
                 (1, 500, 900, "p", "medium"),      # earlier than its predecessor
                 (2, 5000, 6000, "p", "high")]
        self.assertEqual([c[0] for c in align._longest_increasing(found)],
                         [0, 2])


class TestPlaceableGate(unittest.TestCase):
    """What the pre-flight gate must count.

    The gate blocked a real script at 7/106 because it counted only shots
    that matched dialogue. The builder, given the chance, places most of
    those 106 — one quoted line carries every silent shot around it. Blocking
    on the wrong number meant the tool refused to build a video it could
    have built.
    """
    def test_a_run_with_one_anchor_carries_the_whole_run(self):
        beats = beats_from([shot(dialogue="a quoted line"),
                            shot(dialogue=""), shot(dialogue=""),
                            shot(dialogue="")])
        r = align.runs(beats)
        self.assertEqual(len(r), 1)
        self.assertEqual(len(r[0].entries), 4)
        quoted = sum(1 for e in r[0].entries if e.query)
        self.assertEqual(quoted, 1, "one line has to be enough")

    def test_a_run_with_no_quoted_line_anywhere_is_hopeless(self):
        """Interpolation needs something to interpolate between."""
        r = align.runs(beats_from([shot(dialogue=""), shot(dialogue="")]))
        self.assertFalse(any(e.query for e in r[0].entries))



class TestSpanComesFromTheScript(unittest.TestCase):
    """Measured on the real run: 70 shots, 1 anchor, span 2188s-2242s.

    Fifty-four seconds for a scene the script itself describes as 254 — one
    shot every 0.77 s. Every placement landed in the same corner of the
    episode, and the contact sheet came back as the same red-lit frame over
    and over. The old code spread a one-anchor run across a fixed 45 second
    window however many shots it held, so the more the script described, the
    more tightly they were crushed together.
    """
    def _run(self, n, each=3.6):
        return align.Run("Breaking Bad", "S04E01",
                         [align.Entry(beat=i + 1, shot=1,
                                      data={"duration_target_sec": each})
                          for i in range(n)])

    def test_the_axis_is_as_long_as_the_script_says(self):
        run = self._run(70)
        ax = align.axis(run)
        self.assertAlmostEqual(ax[-1] + 1.8, 70 * 3.6, places=3)

    def test_one_anchor_still_spreads_the_whole_scene(self):
        run = self._run(70)
        scale, off = align.fit(run, [(50, 2229000, 2232000, "p", "high")])
        times = [a * scale * 1000 + off for a in align.axis(run)]
        span = (max(times) - min(times)) / 1000.0
        self.assertGreater(span, 200, f"70 shots crushed into {span:.0f}s")
        gaps = [b - a for a, b in zip(sorted(times), sorted(times)[1:])]
        self.assertGreater(min(gaps) / 1000.0, 2.0, "shots land on top of each other")

    def test_the_anchor_keeps_its_own_time(self):
        run = self._run(70)
        scale, off = align.fit(run, [(50, 2229000, 2232000, "p", "high")])
        self.assertAlmostEqual(align.axis(run)[50] * scale * 1000 + off,
                               2229000, delta=1)

    def test_two_anchors_measure_the_stretch_rather_than_assume_it(self):
        run = self._run(70)
        anchors = [(8, 2100000, 2103000, "p", "high"),
                   (50, 2229000, 2232000, "p", "high")]
        scale, off = align.fit(run, anchors)
        ax = align.axis(run)
        for i, start, _e, _p, _c in anchors:
            self.assertAlmostEqual(ax[i] * scale * 1000 + off, start, delta=1)

    def test_a_script_that_misjudges_pacing_is_not_taken_literally(self):
        """duration_target_sec is the CLIP length, not how long the moment
        lasts on screen, so a large ratio is normal and must not be clamped
        away — but an absurd one has to be."""
        run = self._run(8, each=3.0)
        scale, _off = align.fit(run, [(0, 5000, 6000, "p", "high"),
                                      (7, 105000, 106000, "p", "high")])
        self.assertGreater(scale, 3.0)
        self.assertLessEqual(scale, align.MAX_SCALE)


class TestAnchorsSurviveAMisplacedLine(unittest.TestCase):
    """The famous closing line was also quoted at beat 1 as an opener.

    Unwinding backwards from that one crossing took five anchors down to one,
    and seventy shots then hung off a single point. Keeping the longest run
    that IS in order drops the odd misplaced line instead of everything after
    it.
    """
    def test_a_line_quoted_out_of_order_costs_only_itself(self):
        found = [(0, 2229000, 2232000, "p", "high"),     # the ending, first
                 (8, 2100000, 2103000, "p", "high"),
                 (35, 2205000, 2208000, "p", "high"),
                 (50, 2229000, 2232000, "p", "high")]
        kept = align._longest_increasing(found)
        self.assertEqual([k[0] for k in kept], [8, 35, 50])

    def test_an_already_ordered_set_is_kept_whole(self):
        found = [(1, 1000, 1500, "p", "high"), (5, 4000, 4500, "p", "high"),
                 (9, 9000, 9500, "p", "high")]
        self.assertEqual(len(align._longest_increasing(found)), 3)

    def test_the_same_line_at_three_beats_yields_one_anchor(self):
        found = [(0, 2229000, 2232000, "p", "high"),
                 (50, 2229000, 2232000, "p", "high"),
                 (61, 2229000, 2232000, "p", "high")]
        self.assertEqual(len(align._longest_increasing(found)), 1)

    def test_nothing_in_means_nothing_out(self):
        self.assertEqual(align._longest_increasing([]), [])



class TestAQuoteUsedAsAHook(unittest.TestCase):
    """An essay opens by quoting its ending, then earns it.

    On the real script "Well? Get back to work." — the closing line of the
    box-cutter scene — is quoted at shot 1 as a hook and again at 51 and 62
    where it belongs. All three resolve to the same moment, 37:09. Anchoring
    on the first pinned the END of the scene to the START of the run and laid
    all seventy shots after it: the finished sheet opened on Walt hosing down
    the lab, which is what happens once the killing is over.
    """
    def _run(self, n, each=3.6):
        return align.Run("Breaking Bad", "S04E01",
                         [align.Entry(beat=i + 1, shot=1,
                                      data={"duration_target_sec": each})
                          for i in range(n)])

    def test_the_later_occurrence_wins(self):
        found = [(0, 2229000, 2232000, "p", "high"),
                 (50, 2229000, 2232000, "p", "high"),
                 (61, 2229000, 2232000, "p", "high")]
        kept = align.\
            _longest_increasing(align._last_of_each_moment(found))
        self.assertEqual([k[0] for k in kept], [61])

    def test_the_run_then_sits_before_the_line_not_after_it(self):
        run = self._run(70)
        ax = align.axis(run)
        early, late = [], []
        for idx, out in ((0, early), (61, late)):
            scale, off = align.fit(run, [(idx, 2229000, 2232000, "p", "high")])
            out += [a * scale * 1000 + off for a in ax]
        self.assertGreater(min(early) / 1000, 2225)     # starts at the line
        self.assertLess(min(late) / 1000, 2100)         # starts well before it
        self.assertLess(abs(max(late) / 1000 - 2318), 90)

    def test_distinct_moments_are_all_kept(self):
        """Only identical times collapse — two different lines are two anchors."""
        found = [(3, 1000, 1500, "p", "high"), (9, 5000, 5500, "p", "high")]
        self.assertEqual(len(align._last_of_each_moment(found)), 2)

    def test_order_is_preserved(self):
        found = [(9, 5000, 5500, "p", "high"), (3, 1000, 1500, "p", "high")]
        self.assertEqual([a[0] for a in align._last_of_each_moment(found)],
                         [3, 9])



class TestHookQuotes(unittest.TestCase):
    """A line quoted out of sequence must not decide the sequence."""

    def test_a_hook_is_recognised(self):
        e = align.Entry(beat=1, shot=1,
                        data={"exact_dialogue": "x", "hook": True})
        self.assertTrue(e.is_hook)

    def test_an_ordinary_shot_is_not_a_hook(self):
        e = align.Entry(beat=1, shot=1, data={"exact_dialogue": "x"})
        self.assertFalse(e.is_hook)

    def test_a_hook_keeps_its_quote(self):
        """It still names a real moment worth cutting."""
        e = align.Entry(beat=1, shot=1,
                        data={"exact_dialogue": "Well? Get back to work.",
                              "hook": True})
        self.assertTrue(e.query)


if __name__ == "__main__":
    unittest.main(verbosity=2)
