"""Tests for the job queue and its pre-flight gate.

The behaviour these protect is the one that matters at 3 a.m.: a job that
cannot be built is identified BEFORE any rendering starts, is skipped rather
than half-attempted, and never stops the jobs behind it.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import cutter, jobs as jobs_mod, library, probe, runner  # noqa: E402
from media_index.demo import make_demo_video as dv                        # noqa: E402

HAVE_FFMPEG = probe.ffmpeg_bin() is not None
skip_no_ffmpeg = unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")


def shot(source, dialogue):
    return {"source": source, "season_episode": "unknown",
            "exact_dialogue": dialogue, "visual": "x"}


def write_script(path, shots):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump([{"beat": i + 1, "narration": f"Narration {i + 1}.",
                    "shots": [s]} for i, s in enumerate(shots)], f)


class TestJobFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="jobfile_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, payload):
        p = os.path.join(self.tmp, "jobs.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return p

    def test_defaults_apply_to_every_job(self):
        p = self._write({"defaults": {"clip_seconds": 3.0, "height": 720},
                         "jobs": [{"name": "a", "script": "a.json"},
                                  {"name": "b", "script": "b.json"}]})
        for job in jobs_mod.load_jobs(p):
            self.assertEqual(job.clip_seconds, 3.0)
            self.assertEqual(job.height, 720)

    def test_job_overrides_default(self):
        p = self._write({"defaults": {"clip_seconds": 3.0},
                         "jobs": [{"name": "a", "script": "a.json",
                                   "clip_seconds": 6.0}]})
        self.assertEqual(jobs_mod.load_jobs(p)[0].clip_seconds, 6.0)

    def test_relative_paths_resolve_against_the_job_file(self):
        p = self._write({"jobs": [{"name": "a", "script": "scripts/a.json"}]})
        job = jobs_mod.load_jobs(p)[0]
        self.assertTrue(os.path.isabs(job.script))
        self.assertTrue(job.script.startswith(self.tmp))

    def test_bare_list_is_accepted(self):
        p = self._write([{"name": "a", "script": "a.json"}])
        self.assertEqual(len(jobs_mod.load_jobs(p)), 1)

    def test_missing_name_gets_one(self):
        p = self._write({"jobs": [{"script": "a.json"}]})
        self.assertTrue(jobs_mod.load_jobs(p)[0].name)


class _QueueCase(unittest.TestCase):
    """A real two-title library plus scripts of varying health."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="queue_")
        media = os.path.join(cls.tmp, "Media")
        dv.build(os.path.join(media, "Iron Harvest", "Season 01",
                              "Iron.Harvest.S01E01.1080p-PSA.mkv"),
                 log=lambda *a: None)
        dv.build(os.path.join(media, "The Long Winter (2019)",
                              "The.Long.Winter.2019.1080p-PSA.mkv"),
                 log=lambda *a: None)
        cls.db = os.path.join(cls.tmp, "library.db")
        library.build(media, cls.db, log=lambda *a: None)

        sc = os.path.join(cls.tmp, "scripts")
        write_script(os.path.join(sc, "good.json"), [
            shot("Iron Harvest",
                 "I never wanted the harvest. I wanted the land it grew on."),
            shot("Iron Harvest", "Nobody walks out of this clean"),
            shot("Iron Harvest", "Then we burn the field")])
        write_script(os.path.join(sc, "soft.json"), [
            shot("The Long Winter", "Blue segment, a single sentence"),
            shot("The Long Winter", ""),                 # no dialogue at all
            shot("The Long Winter", "Teal, and the last warning"),
            shot("The Long Winter", "Orange, and it is already too late")])
        write_script(os.path.join(sc, "missing.json"), [
            shot("El Camino", "You never asked me what it cost")])
        write_script(os.path.join(sc, "mostly.json"), [
            shot("Iron Harvest", "I never wanted the harvest"),
            shot("Iron Harvest", "Then we burn the field"),
            shot("Iron Harvest", "Nobody walks out of this clean"),
            shot("El Camino", "You never asked me what it cost")])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def job_file(cls, entries, name="jobs.json", **defaults):
        p = os.path.join(cls.tmp, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"defaults": {"db": cls.db, "clip_seconds": 4.0,
                                    "height": 360, **defaults},
                       "jobs": entries}, f)
        return p


@skip_no_ffmpeg
class TestPreflightGate(_QueueCase):
    def _report(self, script, out, **kw):
        p = self.job_file([{"name": "j", "script": f"scripts/{script}",
                            "out": f"gate/{out}", **kw}], name=f"g_{out}.json")
        return jobs_mod.preflight_all(jobs_mod.load_jobs(p))[0]

    def test_healthy_script_is_ready(self):
        self.assertEqual(self._report("good.json", "a").status, "READY")

    def test_one_soft_scene_builds_with_gaps_not_blocked(self):
        """The important call: a video with one weak scene is still a video."""
        rep = self._report("soft.json", "b")
        self.assertEqual(rep.status, "GAPS")
        self.assertFalse(rep.blocked)

    def test_whole_title_missing_is_blocked(self):
        rep = self._report("missing.json", "c")
        self.assertEqual(rep.status, "BLOCKED")
        self.assertTrue(any("sources in library" == c.name and not c.ok
                            for c in rep.checks))

    def test_one_title_of_four_missing_only_downgrades(self):
        """A missing title that costs a quarter of the shots is a gap, not a
        blocker — the other three quarters are still worth building."""
        self.assertEqual(self._report("mostly.json", "d").status, "GAPS")

    def test_missing_script_file_is_blocked(self):
        rep = self._report("does_not_exist.json", "e")
        self.assertEqual(rep.status, "BLOCKED")

    def test_missing_library_is_blocked(self):
        rep = self._report("good.json", "f", db="/nowhere/library.db")
        self.assertEqual(rep.status, "BLOCKED")
        self.assertTrue(any("library index" == c.name and not c.ok
                            for c in rep.checks))

    def test_missing_audio_is_blocked(self):
        rep = self._report("good.json", "g", audio="/nowhere/narration.mp3")
        self.assertEqual(rep.status, "BLOCKED")

    def test_preflight_never_raises(self):
        """A malformed script must produce a report, not an exception."""
        bad = os.path.join(self.tmp, "scripts", "bad.json")
        with open(bad, "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        rep = self._report("bad.json", "h")
        self.assertEqual(rep.status, "BLOCKED")


@skip_no_ffmpeg
class TestQueueRun(_QueueCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.jf = cls.job_file([
            {"name": "All good", "script": "scripts/good.json", "out": "run/a"},
            {"name": "One soft scene", "script": "scripts/soft.json", "out": "run/b"},
            {"name": "Title missing", "script": "scripts/missing.json", "out": "run/c"},
        ], name="run.json")
        cls.results = runner.run_queue(cls.jf, log=lambda *a: None)

    def test_blocked_job_is_skipped_not_attempted(self):
        blocked = self.results[2]
        self.assertEqual(blocked.status, "skipped")
        self.assertEqual(blocked.clips, 0)
        self.assertFalse(os.path.isdir(os.path.join(self.tmp, "run", "c",
                                                    "scene_001")))

    def test_a_blocked_job_does_not_stop_the_others(self):
        self.assertEqual(self.results[0].status, "done")
        self.assertEqual(self.results[1].status, "partial")

    def test_healthy_job_cuts_every_scene(self):
        r = self.results[0]
        self.assertEqual(len(r.scenes), 3)
        self.assertEqual(r.clips, 3)
        self.assertEqual(r.gaps, 0)

    def test_gap_scene_is_reported_not_hidden(self):
        r = self.results[1]
        self.assertEqual(r.gaps, 1)
        empty = [s for s in r.scenes if not s.ok]
        self.assertIn("visual search", empty[0].note)

    def test_output_layout_matches_the_editor_tools(self):
        scene = os.path.join(self.tmp, "run", "a", "scene_001")
        names = os.listdir(scene)
        self.assertTrue(any(n.startswith("clip_") and n.endswith(".mp4")
                            for n in names))
        self.assertTrue(any(n.startswith("image_") and n.endswith(".jpg")
                            for n in names))
        self.assertIn("scene.txt", names)

    def test_manifest_carries_scores_and_provenance(self):
        with open(os.path.join(self.tmp, "run", "a", "manifest.json"),
                  encoding="utf-8") as f:
            man = json.load(f)
        self.assertEqual(len(man["scenes"]), 3)
        first = man["scenes"][0]
        self.assertTrue(first["assets"])
        self.assertIn("score", first["assets"][0])
        self.assertTrue(first["source"])          # which episode it came from

    def test_queue_report_is_written(self):
        self.assertTrue(os.path.isfile(
            os.path.splitext(self.jf)[0] + "_report.json"))

    def test_rerun_resumes_instead_of_rebuilding(self):
        again = runner.run_queue(self.jf, log=lambda *a: None)
        self.assertEqual(again[0].status, "done")
        self.assertTrue(all(s.status == "reused" for s in again[0].scenes))

    def test_dry_run_builds_nothing(self):
        jf = self.job_file(
            [{"name": "dry", "script": "scripts/good.json", "out": "run/dry"}],
            name="dry.json")
        runner.run_queue(jf, log=lambda *a: None, dry_run=True)
        self.assertFalse(os.path.isdir(os.path.join(self.tmp, "run", "dry",
                                                    "scene_001")))


@skip_no_ffmpeg
class TestJobIsolation(_QueueCase):
    def test_a_crashing_job_does_not_kill_the_queue(self):
        """Whatever goes wrong inside one job, the next one still runs."""
        original = cutter.clip_for_hit
        calls = {"n": 0}

        def exploding(hit, out, **kw):
            calls["n"] += 1
            if "boom" in out:
                raise RuntimeError("simulated encoder failure")
            return original(hit, out, **kw)

        jf = self.job_file([
            {"name": "Boom", "script": "scripts/good.json", "out": "boom"},
            {"name": "After", "script": "scripts/good.json", "out": "after"},
        ], name="isolate.json")
        cutter.clip_for_hit = exploding
        try:
            results = runner.run_queue(jf, log=lambda *a: None)
        finally:
            cutter.clip_for_hit = original

        self.assertEqual(results[0].clips, 0)          # every shot failed
        self.assertGreater(results[1].clips, 0)        # the next job still ran
        self.assertEqual(results[1].status, "done")


if __name__ == "__main__":
    unittest.main(verbosity=2)
