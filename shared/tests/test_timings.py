"""Times somebody states, and the runs they rescue.

Every number in here is from a real build log. A run of eighty-five shots
with no quoted line, no picture match above chance, and no opinion about
where in a forty-seven minute episode it happens is not a solvable problem
for any amount of modelling — and it is one line to type.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import align, timings                     # noqa: E402


class TestReadingATimecode(unittest.TestCase):

    def test_the_shapes_people_actually_write(self):
        for text, want in [("29:30", 1770.0), ("1:29:30", 5370.0),
                           ("0:05", 5.0), ("29:30.5", 1770.5),
                           ("1787", 1787.0), ("29m47s", 1787.0),
                           ("1h2m3s", 3723.0), (1787, 1787.0),
                           ("  29:30  ", 1770.0), ("29;30", 1770.0)]:
            self.assertAlmostEqual(timings.parse_timecode(text), want,
                                   msg=repr(text))

    def test_anything_it_cannot_read_is_refused_rather_than_guessed(self):
        """A misread timecode is worse than none: it is a confident wrong
        answer wearing the one label this tool promises never to check."""
        for text in ("", "   ", None, "soon", "the box cutter scene",
                     "29:xx", "--"):
            self.assertIsNone(timings.parse_timecode(text), msg=repr(text))

    def test_a_range_in_every_dash_a_word_processor_makes(self):
        for text in ("29:30-33:40", "29:30 - 33:40", "29:30–33:40",
                     "29:30 to 33:40", "29:30—33:40"):
            self.assertEqual(timings.parse_range(text), (1770.0, 2020.0),
                             msg=repr(text))

    def test_a_single_time_is_a_point_not_a_range(self):
        self.assertEqual(timings.parse_range("29:30"), (1770.0, 1770.0))
        said = timings.Stated(lo=1770.0, hi=1770.0)
        lo, hi = said.window
        self.assertAlmostEqual(hi - lo, timings.POINT_PAD_S * 2)

    def test_a_backwards_range_is_read_the_way_it_was_meant(self):
        self.assertEqual(timings.parse_range("33:40-29:30"), (1770.0, 2020.0))


class TestTheBoxSomebodyTypesInto(unittest.TestCase):

    def test_the_lines_the_placeholder_shows(self):
        got = timings.parse_lines("S04E01 29:30-33:40\n"
                                  "S03E13 30:05-30:35\n"
                                  "Breaking Bad S04E08 43:40-46:30\n")
        self.assertEqual(len(got), 3)
        self.assertEqual((got[0].season, got[0].episode), (4, 1))
        self.assertEqual(got[0].window, (1770.0, 2020.0))
        self.assertEqual(got[2].show, "Breaking Bad")

    def test_other_ways_of_naming_an_episode(self):
        got = timings.parse_lines("4x01 29:30-33:40\ns4e1: 10:00\n")
        self.assertEqual(len(got), 2)
        self.assertEqual((got[0].season, got[0].episode), (4, 1))
        self.assertEqual((got[1].season, got[1].episode), (4, 1))

    def test_a_stray_line_is_skipped_not_raised_on(self):
        """Somebody pasting six lines out of a chat window will have a
        heading in there. Losing the whole box to it, right before a
        two-hour build, is a poor trade for strictness nobody asked for."""
        got = timings.parse_lines("Here are the timings:\n"
                                  "# my notes\n"
                                  "\n"
                                  "S04E01 29:30-33:40\n"
                                  "thanks!\n")
        self.assertEqual(len(got), 1)
        self.assertEqual((got[0].season, got[0].episode), (4, 1))

    def test_an_empty_box_states_nothing(self):
        self.assertEqual(timings.parse_lines(""), [])
        self.assertEqual(timings.parse_lines(None), [])


def _beats(shots=6, se="S04E01", show="Breaking Bad", **extra):
    return [{"beat": 1, "shots": [
        dict({"kind": "clip", "source": show, "season_episode": se,
              "visual": f"shot {i}", "duration_target_sec": 5}, **extra)
        for i in range(shots)]}]


class TestWhatAStatedTimeDoes(unittest.TestCase):

    def test_the_whole_run_is_confined_to_what_was_stated(self):
        beats = _beats()
        said = timings.parse_lines("S04E01 29:30-33:40")
        got = timings.windows_for(beats, said)
        self.assertEqual(got[1], (1770.0, 2020.0))

    def test_a_line_about_a_different_episode_is_ignored(self):
        beats = _beats(se="S04E01")
        said = timings.parse_lines("S02E07 29:30-33:40")
        self.assertEqual(timings.windows_for(beats, said), {})

    def test_a_line_naming_a_different_show_is_ignored(self):
        beats = _beats(show="Breaking Bad")
        said = timings.parse_lines("Game of Thrones S04E01 29:30-33:40")
        self.assertEqual(timings.windows_for(beats, said), {})

    def test_the_box_in_front_of_you_beats_the_script_written_days_ago(self):
        beats = _beats(scene_range="10:00-12:00")
        said = (timings.from_script(beats)
                + timings.parse_lines("S04E01 29:30-33:40"))
        self.assertEqual(timings.windows_for(beats, said)[1], (1770.0, 2020.0))

    def test_a_script_can_state_the_range_itself(self):
        beats = _beats(scene_range="29:30-33:40")
        said = timings.from_script(beats)
        self.assertEqual(len(said), 1)
        self.assertEqual(said[0].window, (1770.0, 2020.0))

    def test_every_name_a_model_might_use_for_the_field(self):
        for key in timings.RANGE_KEYS:
            said = timings.from_script(_beats(**{key: "29:30-33:40"}))
            self.assertEqual(len(said), 1, msg=key)

    def test_the_runs_nobody_stated_a_time_for_come_back_worst_first(self):
        beats = [{"beat": 1, "shots": [
                    {"source": "Breaking Bad", "season_episode": "S04E01",
                     "visual": f"a {i}"} for i in range(85)]},
                 {"beat": 2, "shots": [
                    {"source": "Breaking Bad", "season_episode": "S03E13",
                     "visual": f"b {i}"} for i in range(6)]}]
        left = timings.unstated(beats, timings.parse_lines("S03E13 30:05"))
        self.assertEqual(len(left), 1)
        self.assertEqual(left[0][0], 85)
        self.assertIn("S04E01", left[0][1])


class TestAStatedShotTime(unittest.TestCase):
    """A time on one shot is an anchor, and enters as the strongest kind
    there is — the only evidence in this package that was never inferred."""

    def _run(self, **extra):
        beats = [{"beat": 1, "shots": [
            dict({"source": "Show", "season_episode": "S01E01",
                  "visual": f"shot {i}", "duration_target_sec": 4},
                 **(extra if i == 2 else {}))
            for i in range(6)]}]
        return align.runs(beats)[0]

    def test_a_stated_shot_becomes_an_anchor_without_any_subtitle(self):
        run = self._run(at="29:30")
        with mock.patch.object(align, "episode_file",
                                        return_value="/lib/ep.mkv"):
            got = align.stated_anchors("db", run)
        self.assertEqual(len(got), 1)
        index, start_ms, _end, path, conf = got[0]
        self.assertEqual(index, 2)
        self.assertEqual(start_ms, 1770_000)
        self.assertEqual(path, "/lib/ep.mkv")
        self.assertEqual(conf, "high")

    def test_every_name_a_model_might_use_for_a_shot_time(self):
        for key in timings.SHOT_TIME_KEYS:
            run = self._run(**{key: 1770})
            with mock.patch.object(align, "episode_file",
                                            return_value="/lib/ep.mkv"):
                self.assertEqual(len(align.stated_anchors("db", run)), 1,
                                 msg=key)

    def test_a_run_stating_nothing_produces_no_anchors(self):
        with mock.patch.object(align, "episode_file",
                                        return_value="/lib/ep.mkv"):
            self.assertEqual(align.stated_anchors("db", self._run()), [])

    def test_an_episode_the_library_cannot_resolve_is_skipped(self):
        run = self._run(at="29:30")
        with mock.patch.object(align, "episode_file",
                                        return_value=""):
            self.assertEqual(align.stated_anchors("db", run), [])


if __name__ == "__main__":
    unittest.main()
