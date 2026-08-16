"""Stage 3: cut matched shots into the manifest the renderer consumes."""
import json
import os
import shutil
import tempfile
import unittest

from media_index import assemble, catalog


def _lib():
    return {
        "e1__0": catalog.Shot("e1__0", "Breaking Bad S04E01", "/e1.mp4",
                             1830, 1835, description="a man zips a coverall",
                             characters=["Gus Fring"], quality="high"),
        "e1__1": catalog.Shot("e1__1", "Breaking Bad S04E01", "/e1.mp4",
                             40, 45, description="a man among wooden crates",
                             characters=["Gus Fring"], quality="high",
                             dialogue="How's it coming?"),
    }


class TestBuildManifest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="asm_")
        self.cuts, self.frames = [], []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _cut(self, path, s, e, out):
        self.cuts.append((path, round(s, 1), round(e, 1)))
        open(out, "w").close()

    def _frame(self, path, t, out, width=None):
        self.frames.append((path, round(t, 1)))
        open(out, "w").close()

    def _beats(self):
        return [
            {"beat": 1, "narration": "He gets changed.", "shots": [
                {"kind": "clip", "season_episode": "S04E01",
                 "scene_range": "27:00-35:00", "visual": "a man zips a coverall",
                 "characters": ["Gus"], "duration_target_sec": 4}]},
            {"beat": 2, "narration": "He picks up the box cutter.", "shots": [
                {"kind": "still", "season_episode": "S04E01",
                 "visual": "a man among crates", "characters": ["Gus"],
                 "exact_dialogue": "How's it coming?"}]},
        ]

    def test_clips_and_stills_are_cut_into_scene_folders(self):
        m = assemble.build_manifest(self._beats(), _lib(), self.tmp,
                                    cut_clip=self._cut, extract_frame=self._frame,
                                    log=lambda *a: None)
        self.assertEqual(len(m["scenes"]), 2)
        # a clip is a "video" asset, a still is an "image" asset
        self.assertEqual(m["scenes"][0]["assets"][0]["kind"], "video")
        self.assertEqual(m["scenes"][1]["assets"][0]["kind"], "image")
        # files land in scene_NNN folders
        self.assertTrue(os.path.isfile(
            os.path.join(self.tmp, "scene_001", "clip_00.mp4")))
        self.assertTrue(os.path.isfile(
            os.path.join(self.tmp, "scene_002", "still_00.jpg")))

    def test_a_clip_is_cut_a_little_longer_than_the_target(self):
        assemble.build_manifest(self._beats(), _lib(), self.tmp,
                                cut_clip=self._cut, extract_frame=self._frame)
        path, s, e = self.cuts[0]
        self.assertGreaterEqual(e - s, assemble.MIN_CLIP_S)   # never too short

    def test_manifest_is_written_and_reloadable_by_the_timeline(self):
        assemble.build_manifest(self._beats(), _lib(), self.tmp,
                                cut_clip=self._cut, extract_frame=self._frame)
        from media_index import timeline
        loaded = timeline.load_manifest(self.tmp)
        self.assertEqual(len(loaded["scenes"]), 2)
        self.assertEqual(loaded["scenes"][0]["assets"][0]["source"],
                         "Breaking Bad S04E01")

    def test_a_failed_cut_is_skipped_not_fatal(self):
        def boom(*a):
            raise RuntimeError("ffmpeg gone")
        m = assemble.build_manifest(self._beats(), _lib(), self.tmp,
                                    cut_clip=boom, extract_frame=boom,
                                    log=lambda *a: None)
        self.assertEqual(m["cut"], 0)
        self.assertEqual(m["skipped"], 2)               # both skipped, no crash


if __name__ == "__main__":
    unittest.main()
