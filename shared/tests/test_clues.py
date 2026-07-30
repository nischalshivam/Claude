"""The third script: remembered dialogue, and what survives being checked.

The clue script is the only input to this tool that is written entirely from
a model's memory, so it is the only one where "did it parse" and "is it
worth anything" are completely different questions. A clue script can be
perfect JSON, name every episode confidently, and contribute nothing —
because not one of its remembered lines is a line anybody said.

These tests are therefore mostly about *rejection*: a wrong episode being
overruled by the subtitle file, a line that does not exist being dropped in
silence, an existing quote never being overwritten by a recalled one. The
happy path is one test. The ways a memory can be wrong are the rest.

Measured on the two real visual scripts this was built against — same essay,
same narration, one written from the clean script and one from a clue script:

    from the clean script:  9 distinct quoted lines across 926 s  (1 / 103 s)
    from the clue script:  19 distinct quoted lines across 154 s  (1 / 8 s)
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import clues, library, probe                  # noqa: E402
from media_index.demo import make_demo_video as dv             # noqa: E402

HAVE_FFMPEG = probe.ffmpeg_bin() is not None
skip_no_ffmpeg = unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")

# Straight out of the demo video's ground truth, so the tests know the answer.
AT_52S = "I never wanted the harvest."
AT_63S = "Yellow, and the argument turns."
NEVER_SAID = "We have to go back to the island right now."


def clue(**kw):
    base = {"clue_id": "C01", "narration_covered": "", "what_happens": "",
            "episode": "", "dialogue_in_scene": [], "dialogue_before": "",
            "dialogue_after": "", "characters_on_screen": []}
    base.update(kw)
    return base


def write(tmp, name, payload):
    path = os.path.join(tmp, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(payload if isinstance(payload, str)
                else json.dumps(payload, ensure_ascii=False))
    return path


def beat(no, narration, shots=1, **shot_kw):
    made = []
    for _ in range(shots):
        s = {"source": "Iron Harvest", "season_episode": "", "visual": "",
             "exact_dialogue": "", "duration_target_sec": 3.0}
        s.update(shot_kw)
        made.append(s)
    return {"beat": no, "narration": narration, "shots": made}


class TestReadingAClueScript(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="clues_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_clue_script_out_of_a_chat_window_still_reads(self):
        """2,373 typographic quotes is what a real one arrived with.

        A clue script can only be produced by copying it out of a chat
        window, so smart quotes are the normal case rather than the broken
        one, and they are straightened without being asked.
        """
        straight = json.dumps({"schema": "clue-1", "clues": [clue(
            what_happens="a man folds his jacket")]})
        curly = straight.replace('"', "”")
        self.assertRaises(json.JSONDecodeError, json.loads, curly)
        got = clues.read(write(self.tmp, "c.json", curly))
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].what_happens, "a man folds his jacket")

    def test_the_summary_document_after_the_clues_is_not_mistaken_for_them(self):
        raw = (json.dumps({"schema": "clue-1", "clues": [clue()]})
               + "\n\n" + json.dumps({"summary": {"clues": 1}})
               + "\n\nC01 is the one I am least sure about.")
        got = clues.read(write(self.tmp, "c.json", raw))
        self.assertEqual(len(got), 1)

    def test_a_file_that_is_not_a_clue_script_says_so_rather_than_crashing(self):
        with self.assertRaises(clues.ClueError):
            clues.read(write(self.tmp, "c.json", "this is a narration script"))
        with self.assertRaises(clues.ClueError):
            clues.read(write(self.tmp, "d.json", {"beats": []}))

    def test_no_path_is_not_an_error(self):
        self.assertEqual(clues.read(""), [])

    def test_lines_are_offered_with_the_in_scene_ones_first(self):
        c = clues._clue_from(clue(dialogue_in_scene=["during"],
                                  dialogue_before="before",
                                  dialogue_after="after"))
        self.assertEqual(c.lines, ["during", "before", "after"])

    def test_a_clue_that_remembered_nothing_offers_nothing(self):
        self.assertEqual(clues._clue_from(clue()).lines, [])


class TestMatchingCluesToBeats(unittest.TestCase):
    """The join is the narration text, because it is the one thing the clue
    script and the visual script are both copied from."""

    def test_a_clue_finds_the_beat_whose_narration_it_covers(self):
        beats = [beat(1, "He takes off his jacket and folds it with care."),
                 beat(2, "Two men are pressed against a tiled wall.")]
        got = clues.match(beats, [clues._clue_from(clue(
            narration_covered="He takes off his jacket, folds it with care."))])
        self.assertEqual(list(got), [1])

    def test_one_clue_covering_three_sentences_still_matches_one_beat(self):
        """The prompt asks for one entry per SCENE, not per sentence, so the
        clue's text is routinely longer than the beat's. Overlap is measured
        against the shorter of the two for exactly that reason."""
        beats = [beat(1, "He folds the jacket.")]
        got = clues.match(beats, [clues._clue_from(clue(
            narration_covered="He walks in without a word. He takes off his "
                              "jacket. He folds the jacket. He rolls up his "
                              "sleeves and picks up the box cutter."))])
        self.assertEqual(list(got), [1])

    def test_an_unrelated_clue_matches_nothing(self):
        beats = [beat(1, "He takes off his jacket and folds it with care.")]
        got = clues.match(beats, [clues._clue_from(clue(
            narration_covered="A chemistry teacher writes on a blackboard."))])
        self.assertEqual(got, {})

    def test_a_beat_takes_the_best_fitting_clue_not_the_first_one(self):
        beats = [beat(1, "He folds the jacket with care.")]
        weak = clue(clue_id="weak", narration_covered="He folds a chair.")
        strong = clue(clue_id="strong",
                      narration_covered="He folds the jacket with care.")
        got = clues.match(beats, [clues._clue_from(weak),
                                  clues._clue_from(strong)])
        self.assertEqual(got[1].clue_id, "strong")

    def test_what_happens_is_used_when_no_narration_was_copied(self):
        beats = [beat(1, "The jacket is folded and set aside.")]
        got = clues.match(beats, [clues._clue_from(clue(
            what_happens="jacket folded and set aside on a chair"))])
        self.assertEqual(list(got), [1])


@skip_no_ffmpeg
class TestWhatSurvivesTheSubtitleFile(unittest.TestCase):
    """The whole point. Nothing a clue says is believed until it is found."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="clues_db_")
        root = os.path.join(cls.tmp, "Iron Harvest", "Season 04")
        dv.build(os.path.join(root, "Iron.Harvest.S04E01.1080p.mkv"),
                 log=lambda *a: None)
        cls.db = os.path.join(cls.tmp, "library.db")
        library.build(root, cls.db, log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_a_remembered_line_that_exists_becomes_a_real_quote(self):
        beats = [beat(1, "He says he never wanted any of it.")]
        got = clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="He says he never wanted any of it.",
            dialogue_in_scene=[AT_52S]))])
        self.assertEqual(got.quotes_added, 1)
        self.assertEqual(beats[0]["shots"][0]["exact_dialogue"], AT_52S)

    def test_a_line_nobody_ever_said_is_dropped_in_silence(self):
        beats = [beat(1, "He says he never wanted any of it.")]
        got = clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="He says he never wanted any of it.",
            dialogue_in_scene=[NEVER_SAID]))])
        self.assertEqual(got.quotes_added, 0)
        self.assertEqual(got.lines_found, 0)
        self.assertEqual(beats[0]["shots"][0]["exact_dialogue"], "")

    def test_two_bracketing_lines_bound_a_scene_nobody_speaks_in(self):
        """The case the whole file exists for.

        A wordless scene has nothing to search for. The line before it and
        the line after it are both real, both in the subtitle file, and
        between them the silence is bounded by measurement.
        """
        beats = [beat(1, "Nobody says anything at all.", shots=3)]
        got = clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="Nobody says anything at all.",
            silent=True, dialogue_before=AT_52S, dialogue_after=AT_63S))])
        self.assertEqual(got.brackets_added, 1)
        lo, hi = got.windows[(1, 1)]
        self.assertLessEqual(lo, 52.0)
        self.assertGreaterEqual(hi, 63.0)
        # Every shot of the beat gets the same window, keyed by (beat, shot).
        self.assertEqual(set(got.windows), {(1, 1), (1, 2), (1, 3)})

    def test_a_wrongly_remembered_episode_is_overruled_by_the_subtitles(self):
        """The prompt's own rule, enforced here: a remembered episode counts
        only where one of that clue's lines was found inside an episode."""
        beats = [beat(1, "He says he never wanted any of it.")]
        got = clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="He says he never wanted any of it.",
            episode="S09E09", episode_confidence="high",
            dialogue_in_scene=[AT_52S]))])
        self.assertEqual(beats[0]["shots"][0]["season_episode"], "S04E01")
        self.assertTrue(got.episodes_corrected)

    def test_an_episode_is_never_filled_in_from_memory_alone(self):
        beats = [beat(1, "He says he never wanted any of it.")]
        clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="He says he never wanted any of it.",
            episode="S09E09", episode_confidence="high",
            dialogue_in_scene=[NEVER_SAID]))])
        self.assertEqual(beats[0]["shots"][0]["season_episode"], "")

    def test_a_quote_the_script_already_had_is_never_overwritten(self):
        """A line in the visual script is somebody's answer already. Trading
        it for a recalled one swaps something checked for something
        remembered, which is the wrong direction."""
        beats = [beat(1, "He says he never wanted any of it.",
                      exact_dialogue=AT_63S)]
        got = clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="He says he never wanted any of it.",
            dialogue_in_scene=[AT_52S]))])
        self.assertEqual(beats[0]["shots"][0]["exact_dialogue"], AT_63S)
        self.assertEqual(got.quotes_added, 0)

    def test_several_remembered_lines_spread_across_the_shots_of_a_beat(self):
        beats = [beat(1, "The argument turns and he answers.", shots=2)]
        got = clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="The argument turns and he answers.",
            dialogue_in_scene=[AT_52S, AT_63S]))])
        self.assertEqual(got.quotes_added, 2)
        self.assertEqual([s["exact_dialogue"] for s in beats[0]["shots"]],
                         [AT_52S, AT_63S])

    def test_people_on_screen_reach_the_shots_they_belong_to(self):
        beats = [beat(1, "He says he never wanted any of it.")]
        clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="He says he never wanted any of it.",
            dialogue_in_scene=[AT_52S],
            characters_on_screen=["Walt", "Jesse"]))])
        self.assertEqual(beats[0]["shots"][0]["characters"], ["Walt", "Jesse"])

    def test_a_clue_script_for_a_different_video_changes_nothing(self):
        beats = [beat(1, "He says he never wanted any of it.")]
        before = json.dumps(beats)
        got = clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="A chemistry teacher writes on a blackboard.",
            dialogue_in_scene=[AT_52S]))])
        self.assertEqual(json.dumps(beats), before)
        self.assertEqual(got.windows, {})
        self.assertEqual(len(got.unmatched), 1)

    def test_the_summary_reports_the_hit_rate_not_the_clue_count(self):
        """A clue script's clue count is a claim; its hit rate is a result."""
        beats = [beat(1, "He says he never wanted any of it.")]
        got = clues.enrich(self.db, beats, [clues._clue_from(clue(
            narration_covered="He says he never wanted any of it.",
            dialogue_in_scene=[AT_52S, NEVER_SAID]))])
        self.assertEqual(got.lines_checked, 2)
        self.assertEqual(got.lines_found, 1)
        self.assertAlmostEqual(got.hit_rate, 0.5)
        self.assertIn("1/2", got.summary())


class TestNeverBreakingABuild(unittest.TestCase):
    """A third, hand-supplied, optional file may contribute nothing. It may
    never be the reason a two-hour build did not start."""

    def test_no_clues_and_no_beats_are_both_harmless(self):
        self.assertEqual(clues.enrich("nope.db", [], []).windows, {})
        self.assertEqual(clues.enrich("nope.db", [beat(1, "x")], []).windows, {})

    def test_a_library_that_does_not_exist_costs_nothing(self):
        beats = [beat(1, "He says he never wanted any of it.")]
        got = clues.enrich("no-such-library.db", beats,
                           [clues._clue_from(clue(
                               narration_covered="He says he never wanted "
                                                 "any of it.",
                               dialogue_in_scene=[AT_52S]))])
        self.assertEqual(got.quotes_added, 0)
        self.assertEqual(beats[0]["shots"][0]["exact_dialogue"], "")

    def test_a_beat_with_no_shots_is_skipped_rather_than_raised_on(self):
        beats = [{"beat": 1, "narration": "He folds the jacket.", "shots": []}]
        clues.enrich("nope.db", beats, [clues._clue_from(clue(
            narration_covered="He folds the jacket."))])


if __name__ == "__main__":
    unittest.main()
