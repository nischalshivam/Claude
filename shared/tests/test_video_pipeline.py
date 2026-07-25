"""Tests for the parts that touch real video: sync detection and cutting.

These render a small video with ffmpeg and are skipped when ffmpeg is absent,
so the suite still runs on a machine without it.

    cd shared && python -m unittest discover tests -v
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import cutter, library, probe, search, subtitles, sync   # noqa: E402
from media_index.demo import make_combined_demo as cdemo               # noqa: E402
from media_index.demo import make_demo_video as dv                        # noqa: E402

HAVE_FFMPEG = probe.ffmpeg_bin() is not None
skip_no_ffmpeg = unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")


def cues_from(pairs, offset_ms=0, scale=1.0):
    return [subtitles.Cue(i, int(a * scale) + offset_ms,
                          int(b * scale) + offset_ms, t)
            for i, (a, b, t) in enumerate(pairs)]


@skip_no_ffmpeg
class TestProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="probe_")
        cls.vid = dv.build(os.path.join(cls.tmp, "v.mkv"), log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_reads_basic_facts(self):
        info = probe.probe(self.vid)
        self.assertAlmostEqual(info.duration, dv.DURATION, delta=0.5)
        self.assertEqual((info.width, info.height), (dv.WIDTH, dv.HEIGHT))
        self.assertTrue(info.has_audio)

    def test_ffmpeg_fallback_matches_ffprobe(self):
        """The stderr parser is the path used when ffprobe is missing."""
        info = probe._probe_with_ffmpeg(self.vid)
        self.assertAlmostEqual(info.duration, dv.DURATION, delta=0.5)
        self.assertEqual((info.width, info.height), (dv.WIDTH, dv.HEIGHT))

    def test_unreadable_file_raises(self):
        bad = os.path.join(self.tmp, "not_a_video.mkv")
        with open(bad, "wb") as f:
            f.write(b"garbage" * 100)
        with self.assertRaises(probe.ProbeError):
            probe.probe(bad)


@skip_no_ffmpeg
class TestSyncDetector(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="sync_")
        cls.vid = dv.build(os.path.join(cls.tmp, "v.mkv"), write_srt=False,
                           log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _check(self, planted_ms, tolerance_ms=150):
        cues = cues_from(dv.CUES, offset_ms=planted_ms)
        r = sync.detect(self.vid, cues, try_framerates=False)
        # the detector reports the correction, i.e. the negative of the drift
        self.assertLessEqual(abs(r.offset_ms + planted_ms), tolerance_ms,
                             f"planted {planted_ms}, detected {r.offset_ms}")
        return r

    def test_detects_late_subtitles(self):
        self.assertEqual(self._check(3000).confidence, "high")

    def test_detects_early_subtitles(self):
        self.assertEqual(self._check(-2500).confidence, "high")

    def test_detects_small_drift(self):
        self._check(250)

    def test_in_sync_reports_in_sync(self):
        r = self._check(0)
        self.assertTrue(r.in_sync)

    def test_survives_unsubtitled_audio(self):
        """Music and sound effects appear in the audio but not the subtitles."""
        extra = sorted(dv.CUES + [(18_000, 20_500, "x"), (38_000, 40_000, "x"),
                                  (68_000, 71_000, "x"), (100_000, 103_000, "x")])
        vid = dv.build(os.path.join(self.tmp, "noisy.mkv"), cues=extra,
                       write_srt=False, log=lambda *a: None)
        r = sync.detect(vid, cues_from(dv.CUES, offset_ms=-4500),
                        try_framerates=False)
        self.assertLessEqual(abs(r.offset_ms - 4500), 150)
        self.assertEqual(r.confidence, "high")

    def test_framerate_stretch_detected(self):
        cues = cues_from(dv.CUES, offset_ms=1200, scale=25.0 / 23.976)
        r = sync.detect(self.vid, cues, try_framerates=True)
        fixed = sync.apply(cues, r.offset_ms, r.scale)
        self.assertLess(abs(fixed[0].start_ms - dv.CUES[0][0]), 250)
        self.assertLess(abs(fixed[-1].start_ms - dv.CUES[-1][0]), 250)

    def test_wrong_subtitles_are_not_trusted(self):
        """The safety case: subtitles from another film must not be applied."""
        other = [(t * 1000, t * 1000 + 2500, "unrelated")
                 for t in (3, 17, 29, 44, 58, 71, 88, 99, 111)]
        r = sync.detect(self.vid, cues_from(other), try_framerates=False)
        self.assertEqual(r.confidence, "low")
        self.assertLess(r.prominence, 0.05)

    def test_apply_does_not_mutate_input(self):
        cues = cues_from(dv.CUES)
        before = cues[0].start_ms
        sync.apply(cues, 5000, 1.0)
        self.assertEqual(cues[0].start_ms, before)


@skip_no_ffmpeg
class TestCutter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="cut_")
        cls.vid = dv.build(os.path.join(cls.tmp, "v.mkv"), log=lambda *a: None)
        cls.boundaries = cutter.detect_shots(cls.vid)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_finds_most_shot_boundaries(self):
        truth = dv.scene_cut_times()
        found = [c for c in truth
                 if any(abs(b - c) < 0.5 for b in self.boundaries)]
        # ffmpeg's scene score misses low-contrast cuts; the pipeline must
        # cope with that rather than assume perfect detection
        self.assertGreaterEqual(len(found), len(truth) - 2)
        for b in self.boundaries:
            self.assertTrue(any(abs(b - c) < 0.5 for c in truth),
                            f"false positive at {b}")

    def test_frame_colour_matches_segment(self):
        for t in (7.0, 22.0, 52.0, 106.0):
            got = cutter.average_rgb(self.vid, t)
            want = dv.color_at(t)
            for a, b in zip(got, want):
                self.assertLessEqual(abs(a - b), 14, f"at t={t}")

    def test_snap_pulls_clip_inside_one_shot(self):
        # a request straddling the cut at 45 s
        cut = cutter.snap(self.boundaries, 43.0, 48.0, 40.0, 52.0)
        self.assertEqual(cut.crossed_shots, 0)
        self.assertGreaterEqual(cut.start, 45.0)

    def test_snap_leaves_clean_request_alone(self):
        cut = cutter.snap(self.boundaries, 46.0, 50.0, 40.0, 55.0)
        self.assertEqual((cut.start, cut.end), (46.0, 50.0))
        self.assertFalse(cut.snapped_start or cut.snapped_end)

    def test_snap_reports_when_it_cannot_fit(self):
        """A shot shorter than the minimum clip is reported, not hidden."""
        cut = cutter.snap([10.0, 11.0], 9.5, 12.0, 5.0, 15.0,
                          min_clip=3.0, max_clip=8.0)
        self.assertGreater(cut.crossed_shots, 0)
        self.assertIn("crosses", cut.note)

    def test_cut_respects_target_duration(self):
        for target in (3.0, 4.0, 5.0):
            out = os.path.join(self.tmp, f"c{target}.mp4")
            cutter.cut_clip(self.vid, 50.0, 50.0 + target, out)
            self.assertAlmostEqual(probe.probe(out).duration, target, delta=0.25)

    def test_extract_frame_writes_an_image(self):
        out = os.path.join(self.tmp, "still.jpg")
        cutter.extract_frame(self.vid, 53.0, out, width=320)
        self.assertGreater(os.path.getsize(out), 500)

    def test_empty_range_rejected(self):
        with self.assertRaises(ValueError):
            cutter.cut_clip(self.vid, 10.0, 10.0, os.path.join(self.tmp, "x.mp4"))


@skip_no_ffmpeg
class TestEndToEnd(unittest.TestCase):
    """Script quote -> correct clip on disk, with the subtitles deliberately
    mistimed so the sync correction is exercised on the way through."""

    DRIFT_MS = 3500

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="e2e_")
        root = os.path.join(cls.tmp, "media", "Iron Harvest", "Season 01")
        cls.vid = dv.build(
            os.path.join(root, "Iron.Harvest.S01E01.1080p.WEB-DL-KOGi.mkv"),
            srt_offset_ms=cls.DRIFT_MS, log=lambda *a: None)
        cls.db = os.path.join(cls.tmp, "library.db")
        library.build(os.path.join(cls.tmp, "media"), cls.db,
                      verify_sync=True, log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_drift_was_corrected_during_indexing(self):
        con = library.connect(self.db)
        row = con.execute("SELECT sub_offset_ms, sync_conf FROM media").fetchone()
        con.close()
        self.assertEqual(row["sync_conf"], "high")
        self.assertLessEqual(abs(row["sub_offset_ms"] + self.DRIFT_MS), 150)

    def test_quote_resolves_to_true_position(self):
        hit = search.find(
            self.db, "I never wanted the harvest. I wanted the land it grew on.")[0]
        self.assertEqual(hit.confidence, "high")
        # ground truth from the generator, NOT from the (mistimed) subtitle file
        self.assertLessEqual(abs(hit.start_ms - 52_000), 200)

    def test_clip_shows_the_right_scene(self):
        hit = search.find(self.db, "I never wanted the harvest")[0]
        out = os.path.join(self.tmp, "clip.mp4")
        cut = cutter.clip_for_hit(hit, out, target_seconds=4.0)
        self.assertAlmostEqual(cut.duration, 4.0, delta=0.2)
        want = dv.color_at(53.0)
        got = cutter.average_rgb(out, cut.duration / 2)
        for a, b in zip(got, want):
            self.assertLessEqual(abs(a - b), 14,
                                 f"clip colour {got} != segment colour {want}")


@skip_no_ffmpeg
class TestCombinedSeasonFile(unittest.TestCase):
    """A single file holding several episodes — a very common download shape.

    The danger is silent: "S01E01-E07.mkv" also matches the plain "S01E01"
    pattern, so without care an entire season is filed as episode one.
    """

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="combined_")
        root = os.path.join(cls.tmp, "Iron Harvest")
        cls.vid = cdemo.build(
            os.path.join(root, "Iron_Harvest_S01_COMBINED_720p_BluRay_HEVC.mkv"),
            log=lambda *a: None)
        cls.db = os.path.join(cls.tmp, "library.db")
        cls.res = library.build(root, cls.db, log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_not_mistaken_for_episode_one(self):
        con = library.connect(self.db)
        row = con.execute("SELECT is_combined, season FROM media").fetchone()
        con.close()
        self.assertTrue(row["is_combined"])
        self.assertEqual(row["season"], 1)

    def test_scan_warns_that_the_file_is_combined(self):
        self.assertTrue(any("several episodes" in w
                            for _, w in self.res.warnings))

    def test_chapters_were_stored(self):
        con = library.connect(self.db)
        n = con.execute("SELECT COUNT(*) FROM chapter").fetchone()[0]
        con.close()
        self.assertEqual(n, len(cdemo.EPISODES))

    def test_hit_names_its_episode(self):
        hit = search.find(self.db, "I came back for the people on it")[0]
        self.assertTrue(hit.is_combined)
        self.assertEqual(hit.chapter_index, 2)          # third episode
        self.assertIn("E03", hit.label)

    def test_timecode_is_reported_within_the_episode(self):
        hit = search.find(self.db, "I came back for the people on it")[0]
        # 52 s into episode 3, which itself starts two episodes in
        self.assertAlmostEqual(hit.chapter_offset_ms, 52_000, delta=1500)
        self.assertAlmostEqual(hit.start_ms, 2 * cdemo.EPISODE_SECONDS * 1000 + 52_000,
                               delta=1500)

    def test_recap_and_original_are_both_found(self):
        """Every episode opens with a recap, so the same line really does
        occur more than once inside one file. Keeping only the best hit per
        file hid the second one entirely."""
        hits = search.find(self.db, "I never wanted the harvest", limit=4)
        chapters = {h.chapter_index for h in hits if h.confidence == "high"}
        self.assertIn(0, chapters)      # the original, in episode 1
        self.assertIn(1, chapters)      # the recap, in episode 2

    def test_cut_from_a_combined_file_lands_correctly(self):
        hit = search.find(self.db, "I came back for the people on it")[0]
        out = os.path.join(self.tmp, "clip.mp4")
        cut = cutter.clip_for_hit(hit, out, target_seconds=4.0)
        want = dv.color_at(53.0)                 # colour 53 s into any episode
        got = cutter.average_rgb(out, cut.duration / 2)
        for a, b in zip(got, want):
            self.assertLessEqual(abs(a - b), 14)


class TestSubtitleScript(unittest.TestCase):
    """Hindi subtitles indexed against an English script match nothing, with
    no explanation — unless we notice and say so."""

    def _cues(self, text):
        return [subtitles.Cue(0, 0, 1000, text)]

    def test_detects_latin(self):
        self.assertEqual(
            subtitles.detect_script(self._cues("I never wanted the harvest")),
            "latin")

    def test_detects_devanagari(self):
        self.assertEqual(
            subtitles.detect_script(self._cues("मैंने कभी फ़सल नहीं चाही थी")),
            "devanagari")

    def test_romanised_hindi_reads_as_latin(self):
        self.assertEqual(
            subtitles.detect_script(self._cues("Maine kabhi fasal nahi chahi")),
            "latin")

    def test_detects_cjk(self):
        self.assertEqual(
            subtitles.detect_script(self._cues("私は収穫を望んでいなかった")), "cjk")


if __name__ == "__main__":
    unittest.main(verbosity=2)
