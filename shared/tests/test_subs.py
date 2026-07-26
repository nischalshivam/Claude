"""Tests for attaching a downloaded subtitle pack to the videos.

A season pack does not use your filenames and usually holds several versions
of each episode, timed for different releases. Picking the wrong one is worse
than picking none: the index looks healthy and every clip lands beside its
line.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import (library, probe, search, subs,              # noqa: E402
                         subtitles)
from media_index.demo import make_demo_video as dv                  # noqa: E402
from media_index.demo.make_demo_library import srt                  # noqa: E402

HAVE_FFMPEG = probe.ffmpeg_bin() is not None


class TestEpisodeParsing(unittest.TestCase):
    """Both sides must be understood — the pack writes 1x01, the videos often
    write 'Season 1 Episode 1'."""

    def test_subtitle_pack_naming(self):
        self.assertEqual(
            subs.episode_of("Breaking Bad - 1x01 - Pilot.DVDRip.ORPHEUS.en.srt"),
            (1, 1))
        self.assertEqual(
            subs.episode_of("Breaking Bad - 1x05 - Gray Matter.DSR.LOL.en.srt"),
            (1, 5))

    def test_video_naming(self):
        self.assertEqual(
            subs.episode_of("Breaking Bad Season 2 Episode 13.mkv"), (2, 13))
        self.assertEqual(subs.episode_of("Show.S04E01.1080p.mkv"), (4, 1))
        self.assertEqual(subs.episode_of("Show_S04_E07_x265.mkv"), (4, 7))

    def test_nothing_recognisable(self):
        self.assertIsNone(subs.episode_of("random notes.txt"))


class TestRealSeasonFolder(unittest.TestCase):
    """The exact shape of a real D:\\Breaking Bad Season 2 folder.

    Thirteen episodes named one way, thirty-nine subtitles named another,
    all in a single folder with no subfolders — which is how a season pack
    and a season download actually land on disk once you stop tidying them
    by hand. The two sides share no filename text beyond the show, so the
    episode number is the only thing that can join them.
    """

    TITLES = {1: "Seven Thirty-Seven", 2: "Grilled", 3: "Bit by a Dead Bee",
              4: "Down", 5: "Breakage", 6: "Peekaboo", 7: "Negro Y Azul",
              8: "Better Call Saul", 9: "4 Days Out", 10: "Over",
              11: "Mandala", 12: "Phoenix", 13: "ABQ"}
    RELEASES = ["720p HDTV.CTU", "DVDRip.en", "HDTV.0TV"]

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        for ep, title in self.TITLES.items():
            with open(os.path.join(
                    self.dir, f"Breaking Bad Season 2 Episode {ep}.mkv"),
                    "wb") as f:
                f.write(b"\0" * 300_000)     # over naming.MIN_MEDIA_BYTES
            for rel in self.RELEASES:
                name = f"Breaking Bad - 2x{ep:02d} - {title}.{rel}.en.srt"
                with open(os.path.join(self.dir, name), "w") as f:
                    f.write("1\n00:00:01,000 --> 00:00:03,000\nline\n\n")

    def test_the_videos_are_understood(self):
        from media_index import naming
        seen = {}
        for path in naming.walk_media(self.dir):
            m = naming.parse(path)
            self.assertEqual(m.show, "Breaking Bad", path)
            self.assertEqual(m.season, 2, path)
            seen[m.episode] = m.confidence
        self.assertEqual(sorted(seen), list(range(1, 14)))
        self.assertEqual(set(seen.values()), {"high"})

    def test_the_pack_covers_every_episode(self):
        pool = subs.collect(self.dir)
        self.assertEqual(sorted(pool), [(2, e) for e in range(1, 14)])
        self.assertEqual({len(v) for v in pool.values()}, {3})

    def test_each_episode_is_linked_to_its_own_subtitle(self):
        """Not merely 13 links — 13 links to the RIGHT episodes.

        Counting them is not enough. Episode 9 taking episode 1's subtitle
        would still count as thirteen, and every clip in the finished video
        would be from the wrong scene.
        """
        results = subs.link(self.dir, verify=False, log=lambda *a: None)
        self.assertEqual(len(results), 13)
        for m in results:
            self.assertNotEqual(m.status, "none", m.note)
            self.assertIn(f"2x{m.episode:02d}", os.path.basename(m.chosen))
            self.assertIn(self.TITLES[m.episode],
                          os.path.basename(m.chosen))
            self.assertTrue(os.path.isfile(m.written))
            self.assertTrue(m.written.endswith(
                f"Breaking Bad Season 2 Episode {m.episode}.en.srt"))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class TestLinkPack(unittest.TestCase):
    """Exactly the shape of the real download: three versions per episode,
    named nothing like the videos."""

    VERSIONS = (("DVDRip.ORPHEUS", 0), ("DSR.0TV", -9500), ("DVDRip", 21000))

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="subs_")
        self.vids = os.path.join(self.tmp, "Breaking Bad Season 1")
        self.pack = os.path.join(self.tmp, "Breaking_Bad - season 1.en")
        os.makedirs(self.pack)
        for ep in (1, 2):
            dv.build(os.path.join(
                self.vids, f"Breaking Bad Season 1 Episode {ep}.mkv"),
                write_srt=False, log=lambda *a: None)
            for tag, off in self.VERSIONS:
                cues = [(max(0, a + off), max(500, b + off), t)
                        for a, b, t in dv.CUES]
                name = f"Breaking Bad - 1x{ep:02d} - Title.{tag}.en.srt"
                with open(os.path.join(self.pack, name), "w",
                          encoding="utf-8") as f:
                    f.write(srt(cues))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_collect_groups_versions_by_episode(self):
        pool = subs.collect(self.pack)
        self.assertEqual(sorted(pool), [(1, 1), (1, 2)])
        self.assertEqual(len(pool[(1, 1)]), 3)

    def test_every_episode_gets_one(self):
        matches = subs.link(self.vids, self.pack, log=lambda *a: None)
        self.assertEqual(len(matches), 2)
        self.assertTrue(all(m.status == "linked" for m in matches))
        for m in matches:
            self.assertTrue(os.path.isfile(m.written))
            self.assertTrue(m.written.endswith(".en.srt"))

    def test_the_version_that_fits_the_video_is_chosen(self):
        """The whole point: three candidates, only one is timed for this copy."""
        matches = subs.link(self.vids, self.pack, log=lambda *a: None)
        for m in matches:
            self.assertIn("ORPHEUS", m.chosen)
            self.assertLess(abs(m.offset_ms), 1000)

    def test_index_then_finds_dialogue_at_its_true_position(self):
        subs.link(self.vids, self.pack, log=lambda *a: None)
        db = os.path.join(self.tmp, "library.db")
        library.build(self.vids, db, verify_sync=True, log=lambda *a: None)
        hits = search.find(
            db, "I never wanted the harvest. I wanted the land it grew on.")
        self.assertTrue(hits)
        self.assertEqual(hits[0].confidence, "high")
        self.assertLessEqual(abs(hits[0].start_ms - 52_000), 300)

    def test_existing_subtitle_is_left_alone(self):
        subs.link(self.vids, self.pack, log=lambda *a: None)
        again = subs.link(self.vids, self.pack, log=lambda *a: None)
        self.assertTrue(all(m.status == "already" for m in again))

    def test_overwrite_relinks(self):
        subs.link(self.vids, self.pack, log=lambda *a: None)
        again = subs.link(self.vids, self.pack, overwrite=True,
                          log=lambda *a: None)
        self.assertTrue(all(m.status == "linked" for m in again))

    def test_missing_episode_is_reported_not_guessed(self):
        for f in os.listdir(self.pack):
            if "1x02" in f:
                os.remove(os.path.join(self.pack, f))
        matches = {m.label: m for m in
                   subs.link(self.vids, self.pack, log=lambda *a: None)}
        self.assertEqual(matches["Breaking Bad S01E02"].status, "none")
        self.assertIn("no subtitle", matches["Breaking Bad S01E02"].note)

    def test_no_verify_still_links_something(self):
        matches = subs.link(self.vids, self.pack, verify=False,
                            log=lambda *a: None)
        self.assertTrue(all(m.status == "unverified" for m in matches))
        self.assertTrue(all(os.path.isfile(m.written) for m in matches))

    def test_report_renders(self):
        text = subs.format_results(
            subs.link(self.vids, self.pack, log=lambda *a: None))
        self.assertIn("linked", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestSubtitlesFolderBesideTheVideos(unittest.TestCase):
    """One tidy `Subtitles` folder per season, one file per episode.

    This is what a person does after being burned by duplicate packs, and it
    failed twice over. The sidecar search only accepted folders spelled
    `Subs*`, so a folder plainly labelled `Subtitles` was invisible; and the
    episode parser inside subtitles.py was a second, older copy of the one in
    subs.py that had never learned "Season 2 Episode 1". Both halves had to
    agree for the folder to be seen at all, and they did not.
    """
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.season = os.path.join(self.tmp, "Breaking Bad Season 2")
        subdir = os.path.join(self.season, "Subtitles")
        os.makedirs(subdir)
        for ep in range(1, 14):
            with open(os.path.join(
                    self.season,
                    f"Breaking Bad Season 2 Episode {ep}.mp4"), "wb") as f:
                f.write(b"\0" * 300_000)
            with open(os.path.join(
                    subdir, f"Breaking Bad S1-S5-English-S2E{ep}.srt"),
                    "w", encoding="utf-8") as f:
                f.write("1\n00:00:01,000 --> 00:00:03,000\n"
                        f"this line belongs to episode {ep}\n\n")

    def test_both_spellings_of_the_episode_are_understood(self):
        """The two sides of the match write it completely differently."""
        self.assertEqual(
            subtitles.episode_key("Breaking Bad Season 2 Episode 10.mp4"),
            (2, 10))
        self.assertEqual(
            subtitles.episode_key("Breaking Bad S1-S5-English-S2E10.srt"),
            (2, 10))

    def test_a_leading_range_does_not_hijack_the_episode(self):
        """"S1-S5" sits before the real marker in every one of these names."""
        self.assertEqual(
            subtitles.episode_key("Breaking Bad S1-S5-English-S4E13.srt"),
            (4, 13))

    def test_every_episode_finds_its_own_file(self):
        """Counting thirteen is not the test — thirteen CORRECT is."""
        for ep in range(1, 14):
            video = os.path.join(
                self.season, f"Breaking Bad Season 2 Episode {ep}.mp4")
            found = subtitles.find_sidecar(video)
            self.assertIsNotNone(found, f"episode {ep} found nothing")
            self.assertEqual(os.path.basename(found),
                             f"Breaking Bad S1-S5-English-S2E{ep}.srt")

    def test_the_text_that_loads_is_the_right_episode(self):
        _kind, _path, cues = subtitles.load_for_video(os.path.join(
            self.season, "Breaking Bad Season 2 Episode 7.mp4"))
        self.assertTrue(cues)
        self.assertIn("episode 7", cues[0].text)

    def test_the_index_then_holds_thirteen_distinct_episodes(self):
        db = os.path.join(self.tmp, "library.db")
        library.build(self.season, db, log=lambda *a: None)
        con = library.connect(db)
        rows = con.execute(
            "SELECT m.episode, c.text FROM media m JOIN cue c ON c.media_id=m.id"
        ).fetchall()
        con.close()
        self.assertEqual(len(rows), 13)
        for episode, text in rows:
            self.assertIn(f"episode {episode}", text)
