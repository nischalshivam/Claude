"""Tests for turning a timeline into a file that plays.

Everything before this stage produces folders, and a folder cannot tell you
that a cut lands two beats late or that a still sits dead on screen for nine
seconds. Until something plays end to end there is nothing to judge.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import cutter, probe, render                   # noqa: E402
from media_index.demo import make_demo_video as dv              # noqa: E402

HAVE_FFMPEG = probe.ffmpeg_bin() is not None


class TestTheMoveOnAHeldFrame(unittest.TestCase):
    """A still held for ten seconds is a slideshow, and a slideshow is the
    second thing a viewer notices after identical durations."""

    def test_a_still_is_given_motion_by_default(self):
        self.assertIn("zoompan", render.still_filter(6.0, seed=1))

    def test_the_move_can_be_turned_off(self):
        got = render.still_filter(6.0, seed=1, motion=False)
        self.assertNotIn("zoompan", got)
        self.assertIn("scale", got)

    def test_neighbouring_stills_do_not_all_drift_the_same_way(self):
        # Twenty stills pushing in at the same rate is a signature of its
        # own — subtler than identical durations, and just as machine-like.
        moves = {render.still_filter(5.0, seed=i) for i in range(12)}
        self.assertGreater(len(moves), 6, "the motion barely varies")

    def test_the_same_shot_moves_the_same_way_every_render(self):
        # A review step is worthless if re-rendering changes what was
        # reviewed.
        self.assertEqual(render.still_filter(5.0, seed=7),
                         render.still_filter(5.0, seed=7))

    def test_the_motion_happens_at_double_resolution(self):
        """Panning a 1920-wide still directly makes the pixel grid crawl."""
        got = render.still_filter(5.0, seed=2)
        self.assertIn(f"scale={render.WIDTH * 2}", got)
        self.assertIn(f"s={render.WIDTH}x{render.HEIGHT}", got)

    def test_a_very_short_still_still_gets_enough_frames(self):
        self.assertIn("d=", render.still_filter(0.01, seed=1))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class TestRenderingAWholeTimeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="render_")
        src = dv.build(os.path.join(cls.tmp, "src.mkv"), log=lambda *a: None)
        scene = os.path.join(cls.tmp, "scene_001")
        os.makedirs(scene, exist_ok=True)
        cutter.cut_clip(src, 5.0, 10.0, os.path.join(scene, "clip_01.mp4"),
                        height=720)
        cutter.extract_frame(src, 20.0, os.path.join(scene, "image_01_1.jpg"),
                             width=1920)
        cutter.extract_frame(src, 40.0, os.path.join(scene, "image_01_2.jpg"),
                             width=1920)
        cls.src = src

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.out = tempfile.mkdtemp(prefix="out_", dir=self.tmp)
        for name in ("scene_001",):
            shutil.copytree(os.path.join(self.tmp, name),
                            os.path.join(self.out, name))

    def _timeline(self, durations=(3.4, 5.2, 4.1)):
        files = [("clip_01.mp4", "video"), ("image_01_1.jpg", "image"),
                 ("image_01_2.jpg", "image")]
        items, t = [], 0.0
        for (name, kind), d in zip(files, durations):
            items.append({"file": name, "kind": kind, "start": round(t, 2),
                          "duration": d})
            t += d
        return {"scenes": [{"scene": 1, "items": items}]}

    def test_it_writes_a_file_that_plays(self):
        res = render.render(self._timeline(), os.path.join(self.out, "v.mp4"),
                            source_dir=self.out)
        self.assertTrue(res.ok, res.failed)
        self.assertEqual(res.segments, 3)

    def test_the_video_is_as_long_as_the_timeline_says(self):
        res = render.render(self._timeline(), os.path.join(self.out, "v.mp4"),
                            source_dir=self.out)
        self.assertAlmostEqual(res.duration, 12.7, delta=0.4)

    def test_every_segment_comes_out_the_same_shape(self):
        # Concatenating without re-encoding only works if they agree, and a
        # mismatch shows up as a file that plays for two seconds and stops.
        render.render(self._timeline(), os.path.join(self.out, "v.mp4"),
                      source_dir=self.out)
        work = os.path.join(self.out, render.WORK_DIR)
        sizes = set()
        for name in sorted(os.listdir(work)):
            if name.startswith("seg_"):
                info = probe.probe(os.path.join(work, name))
                sizes.add((info.width, info.height))
        self.assertEqual(sizes, {(render.WIDTH, render.HEIGHT)})

    def test_a_second_run_reuses_what_it_already_made(self):
        # This is the slow step. A queue of six videos overnight must not
        # lose four hours to one interrupted render.
        render.render(self._timeline(), os.path.join(self.out, "v.mp4"),
                      source_dir=self.out)
        again = render.render(self._timeline(),
                              os.path.join(self.out, "v.mp4"),
                              source_dir=self.out)
        self.assertEqual(again.segments, 0)
        self.assertEqual(again.reused, 3)
        self.assertTrue(again.ok)

    def test_a_missing_asset_is_named_and_the_rest_still_renders(self):
        tl = self._timeline()
        tl["scenes"][0]["items"].append(
            {"file": "not_here.jpg", "kind": "image", "start": 12.7,
             "duration": 3.0})
        res = render.render(tl, os.path.join(self.out, "v.mp4"),
                            source_dir=self.out, resume=False)
        self.assertTrue(res.ok)
        self.assertEqual(len(res.failed), 1)
        self.assertIn("not_here.jpg", res.failed[0][0])

    def test_an_empty_timeline_says_so_rather_than_writing_nothing(self):
        res = render.render({"scenes": []}, os.path.join(self.out, "v.mp4"),
                            source_dir=self.out)
        self.assertFalse(res.ok)
        self.assertIn("no items", res.failed[0][1])

    def test_the_narration_ends_up_on_the_video(self):
        audio = os.path.join(self.out, "narration.m4a")
        probe_ff = probe.require_ffmpeg()
        import subprocess
        subprocess.run([probe_ff, "-y", "-v", "error", "-f", "lavfi",
                        "-i", "sine=frequency=440:duration=12",
                        "-c:a", "aac", audio], check=True)
        res = render.render(self._timeline(),
                            os.path.join(self.out, "v.mp4"),
                            source_dir=self.out, audio=audio, resume=False)
        self.assertTrue(res.ok, res.failed)
        self.assertTrue(probe.probe(res.path).has_audio)

    def test_a_missing_narration_is_reported_but_the_picture_survives(self):
        res = render.render(self._timeline(),
                            os.path.join(self.out, "v.mp4"),
                            source_dir=self.out, audio="/no/such/track.mp3")
        self.assertTrue(res.ok)
        self.assertTrue(any("audio" in a for a, _b in res.failed))

    def test_it_can_be_pointed_at_a_built_folder(self):
        with open(os.path.join(self.out, "timeline.json"), "w",
                  encoding="utf-8") as f:
            json.dump(self._timeline(), f)
        res = render.render_folder(self.out, log=lambda *a: None)
        self.assertTrue(res.ok, res.failed)
        self.assertTrue(res.path.endswith("video.mp4"))

    def test_a_folder_with_no_timeline_says_what_to_do(self):
        res = render.render_folder(self.out, log=lambda *a: None)
        self.assertFalse(res.ok)
        self.assertIn("plan the timing", res.failed[0][1])

    def test_the_summary_reads_like_a_result(self):
        res = render.render(self._timeline(), os.path.join(self.out, "v.mp4"),
                            source_dir=self.out)
        text = render.describe(res)
        self.assertIn("min", text)
        self.assertIn("v.mp4", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
