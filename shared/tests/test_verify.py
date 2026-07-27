"""Tests for looking at the footage and checking it matches the script.

Every other stage of this pipeline places a shot by *inference* — a line was
spoken here, so the shots around it are probably there. This stage is the
only one that checks, and the whole reason it exists is that inference has
been wrong three separate times in a way no guard could have caught.

The model itself is not tested here; a deterministic stand-in is, so that
every decision built around the model — which frame wins, when a match is
disbelieved, whether the order can be broken, what happens when the model is
not installed at all — is covered without downloading two gigabytes.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import align, embed, library, probe, verify, visual  # noqa: E402
from media_index.demo import make_demo_video as dv                    # noqa: E402

HAVE_FFMPEG = probe.ffmpeg_bin() is not None


FRAME_SIZE = 32


def painted(caption: str, size: int = FRAME_SIZE) -> np.ndarray:
    """A fake frame carrying the words it is supposed to depict.

    The deterministic backend reads the caption back out of the top row, so a
    test can build an episode whose frames genuinely "show" known things and
    then assert that the right one is chosen.

    A caption too long for the row is an error rather than a truncation. It
    was a truncation once: "boxcutter" was painted as "boxcutte", the search
    for "boxcutter" quite correctly found nothing, and a test that looked
    like it was failing over the search was failing over its own fixture.
    """
    raw = caption.encode("utf-8")
    if len(raw) > size:
        raise ValueError(f"caption {caption!r} does not fit in {size} bytes")
    frame = np.zeros((size, size, 3), dtype=np.uint8)
    for i, b in enumerate(raw):
        frame[0, i, 0] = b
    return frame


def fake_index(captions, fps=0.5, backend=None, path="/fake/ep.mkv"):
    """A VisualIndex over frames that depict the given captions, in order."""
    backend = backend or embed.Deterministic(dim=64)
    pixels = np.stack([painted(c) for c in captions])
    vecs = backend.encode_images(pixels)
    times = np.array([i / fps for i in range(len(captions))], dtype=np.float32)
    return visual.VisualIndex(path=path, times=times, vecs=vecs,
                              model=backend.name, fps=fps)


class TestTheSentenceAFrameIsScoredAgainst(unittest.TestCase):
    def test_visual_line_is_the_core_of_it(self):
        text = verify.describe({"visual": "Gus picks up the box cutter"})
        self.assertIn("box cutter", text)

    def test_setting_and_characters_are_appended(self):
        text = verify.describe({"visual": "he ties the apron",
                                "setting": "underground superlab",
                                "characters": ["Gus Fring", "Victor"]})
        self.assertIn("apron", text)
        self.assertIn("superlab", text)
        self.assertIn("Gus Fring", text)

    def test_must_not_have_is_left_out(self):
        # It exists to keep fan art out of a web search. Every frame scored
        # here came out of the film, so including it would only add noise.
        text = verify.describe({"visual": "a man in a doorway",
                                "must_not_have": ["fan art", "reaction cam"]})
        self.assertNotIn("fan art", text)

    def test_a_shot_with_no_description_yields_nothing(self):
        self.assertEqual(verify.describe({"kind": "still"}), "")


class TestHowFarPastOrdinary(unittest.TestCase):
    """`lift` is what makes a score mean the same thing on the next film."""

    def test_a_clear_winner_lifts_high(self):
        sims = np.concatenate([np.random.RandomState(1).rand(200) * 0.1,
                               [0.9]])
        self.assertGreater(visual.lift_of(sims, 0.9), 3.0)

    def test_a_typical_frame_lifts_around_nothing(self):
        rng = np.random.RandomState(2).rand(200)
        self.assertLess(abs(visual.lift_of(rng, float(np.median(rng)))), 0.2)

    def test_a_flat_episode_says_nothing_rather_than_infinity(self):
        # Every frame identical, including this one: the spread is zero and a
        # naive ratio would divide by it. Silence is the honest answer.
        self.assertEqual(visual.lift_of(np.full(100, 0.5), 0.5), 0.0)

    def test_the_one_frame_that_stands_alone_is_not_called_nothing(self):
        # Same zero spread, opposite meaning: everything scored alike and one
        # frame did not. Treating that as "no match" is exactly backwards.
        flat = np.full(100, 0.1)
        self.assertGreaterEqual(visual.lift_of(flat, 0.9), visual.LIFT_STRONG)

    def test_the_number_stays_readable(self):
        sims = np.concatenate([np.full(200, 0.10), np.full(9, 0.1001)])
        self.assertLessEqual(visual.lift_of(sims, 50.0), visual.LIFT_CEILING)

    def test_too_few_frames_to_judge_against(self):
        self.assertEqual(visual.lift_of(np.array([0.1, 0.9]), 0.9), 0.0)


class TestChoosingFramesForAWholeRunAtOnce(unittest.TestCase):
    def _score(self, homes, frames_n=20, noise=0.05):
        s = np.random.RandomState(7).rand(len(homes), frames_n) * noise
        for i, f in enumerate(homes):
            s[i, f] = 5.0
        return s

    def test_each_shot_lands_on_its_own_best_frame(self):
        s = self._score([3, 7, 11, 15])
        self.assertEqual(verify.solve(s, [None] * 4), [3, 7, 11, 15])

    def test_order_is_a_constraint_not_a_hope(self):
        # Shot 1 is told frame 2 is a better match than frame 7 — but frame 2
        # is behind shot 0. Six shots each grabbing their favourite frame is
        # how a scene comes back scrambled, and a scramble reads far worse on
        # a timeline than an offset does.
        s = self._score([5, 9, 13])
        s[1, 2] = 9.0
        got = verify.solve(s, [None] * 3)
        self.assertEqual(got, sorted(got))
        self.assertEqual(got[0], 5)

    def test_two_shots_never_share_one_frame(self):
        s = np.zeros((3, 10))
        s[:, 4] = 5.0                       # all three adore frame 4
        got = verify.solve(s, [None] * 3)
        self.assertEqual(len(set(got)), 3)

    def test_a_pinned_shot_stays_inside_its_range(self):
        s = self._score([3, 7, 11, 15])
        got = verify.solve(s, [None, None, (9, 10), None])
        self.assertIn(got[2], (9, 10))

    def test_a_silent_shot_settles_between_its_neighbours(self):
        # The middle shot matches nothing at all. It must not wander to the
        # far end of the episode, and it must not be dropped.
        s = np.zeros((3, 40))
        s[0, 10] = 5.0
        s[2, 20] = 5.0
        got = verify.solve(s, [None] * 3)
        self.assertEqual(got[0], 10)
        self.assertEqual(got[2], 20)
        self.assertTrue(10 < got[1] < 20)

    def test_contradictory_pins_are_reported_not_guessed(self):
        s = self._score([3, 7, 11, 15])
        self.assertEqual(verify.solve(s, [(18, 19), None, None, (1, 2)]), [])

    def test_more_shots_than_frames_is_refused(self):
        self.assertEqual(verify.solve(np.random.rand(30, 5), [None] * 30), [])

    def test_an_empty_problem_is_not_an_error(self):
        self.assertEqual(verify.solve(np.zeros((0, 5)), []), [])


class TestScoresAreComparableBetweenShots(unittest.TestCase):
    def test_each_description_is_normalised_on_its_own(self):
        backend = embed.Deterministic(dim=64)
        index = fake_index(["alpha", "beta", "gamma", "delta", "epsilon",
                            "zeta", "eta", "theta", "iota", "kappa"],
                           backend=backend)
        m = verify.lift_matrix(index, ["alpha", "kappa"], backend)
        self.assertEqual(m.shape, (2, 10))
        # each row peaks on its own frame, and the peaks are of a size
        self.assertEqual(int(np.argmax(m[0])), 0)
        self.assertEqual(int(np.argmax(m[1])), 9)
        self.assertAlmostEqual(float(m[0].max()), float(m[1].max()), delta=1.0)

    def test_a_description_that_cannot_be_encoded_scores_zero(self):
        backend = embed.Deterministic(dim=64)
        index = fake_index([f"w{i}" for i in range(12)], backend=backend)
        m = verify.lift_matrix(index, ["", "w3"], backend)
        self.assertTrue(np.all(m[0] == 0.0))
        self.assertGreater(m[1].max(), 0.0)


class TestPuttingItOnARun(unittest.TestCase):
    """The end of the story: placements go in, corrected placements come out."""

    def setUp(self):
        self.backend = embed.Deterministic(dim=64)
        # A twenty-frame "episode" (one frame every two seconds) in which
        # three known moments happen at 6s, 20s and 34s.
        captions = [f"filler{i}" for i in range(20)]
        captions[3] = "doorway"
        captions[10] = "apron"
        captions[17] = "cutter"
        self.index = fake_index(captions, backend=self.backend)

    def _run(self, visuals, hooks=()):
        entries = [align.Entry(beat=1, shot=i + 1,
                               data={"visual": v, "duration_target_sec": 4,
                                     **({"hook": True} if i in hooks else {})})
                   for i, v in enumerate(visuals)]
        return align.Run(source="Show", season_episode="S01E01",
                         entries=entries)

    def _placements(self, run, start_s):
        return [align.Placement(beat=e.beat, shot=e.shot, path=self.index.path,
                                start_ms=int(s * 1000),
                                end_ms=int(s * 1000) + 4000,
                                method="interpolated", confidence="low")
                for e, s in zip(run.entries, start_s)]

    def test_a_badly_placed_run_is_dragged_onto_the_real_moments(self):
        run = self._run(["doorway", "apron", "cutter"])
        # alignment put the whole run in the wrong half of the episode
        places = self._placements(run, [1.0, 2.0, 3.0])
        verdicts = verify.verify_run(self.index, run, places, self.backend)
        self.assertEqual([p.start_ms for p in places], [6000, 20000, 34000])
        self.assertTrue(all(v.lift > 0 for v in verdicts))
        self.assertTrue(any(v.action == "moved" for v in verdicts))

    def test_a_shot_that_matches_nothing_is_marked_not_hidden(self):
        run = self._run(["doorway", "nothinglikethis", "cutter"])
        places = self._placements(run, [6.0, 20.0, 34.0])
        verdicts = verify.verify_run(self.index, run, places, self.backend)
        middle = verdicts[1]
        self.assertEqual(middle.action, "drifted")
        self.assertEqual(places[1].confidence, "low")
        self.assertIn("no frame", places[1].note)
        # ...but it is still placed, in order, between the two that matched
        self.assertLess(places[0].start_ms, places[1].start_ms)
        self.assertLess(places[1].start_ms, places[2].start_ms)

    def test_an_anchored_shot_is_never_moved_off_its_line(self):
        run = self._run(["doorway", "apron", "cutter"])
        places = self._placements(run, [6.0, 25.0, 34.0])
        places[1].method, places[1].confidence = "anchor", "high"
        verify.verify_run(self.index, run, places, self.backend)
        self.assertEqual(places[1].start_ms, 25000)

    def test_a_hook_takes_no_part_in_the_ordering(self):
        # The hook quotes the END of the scene at shot 1. Including it would
        # force every later shot after it and break the run; it is left where
        # its line put it and ignored.
        run = self._run(["cutter", "doorway", "apron"], hooks={0})
        places = self._placements(run, [34.0, 1.0, 2.0])
        places[0].method, places[0].confidence = "anchor", "high"
        verdicts = verify.verify_run(self.index, run, places, self.backend)
        self.assertEqual(places[0].start_ms, 34000)
        self.assertIn("hook", verdicts[0].note)
        self.assertEqual(places[1].start_ms, 6000)
        self.assertEqual(places[2].start_ms, 20000)

    def test_contradictory_anchors_fall_back_to_the_pictures(self):
        said = []
        run = self._run(["doorway", "apron", "cutter"])
        places = self._placements(run, [34.0, 20.0, 4.0])
        places[0].method, places[0].confidence = "anchor", "high"
        places[2].method, places[2].confidence = "anchor", "high"
        verify.verify_run(self.index, run, places, self.backend,
                          log=said.append)
        self.assertTrue(any("contradict" in s for s in said), said)
        self.assertEqual([p.start_ms for p in places], [6000, 20000, 34000])

    def test_a_confirmed_shot_is_labelled_so_the_manifest_can_show_it(self):
        run = self._run(["doorway", "apron", "cutter"])
        places = self._placements(run, [1.0, 2.0, 3.0])
        verify.verify_run(self.index, run, places, self.backend)
        self.assertTrue(all(p.method == "verified" for p in places))

    def test_the_clip_keeps_the_length_it_was_given(self):
        run = self._run(["doorway", "apron", "cutter"])
        places = self._placements(run, [1.0, 2.0, 3.0])
        verify.verify_run(self.index, run, places, self.backend)
        for p in places:
            self.assertEqual(p.end_ms - p.start_ms, 4000)


class TestWhenTheModelIsNotThere(unittest.TestCase):
    """A build must never fail, or change, because this stage cannot run."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="verify_")
        self.db = os.path.join(self.tmp, "library.db")
        library.connect(self.db).close()
        embed.set_backend(None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        embed.set_backend(None)

    def _beats(self):
        return [{"beat": 1, "shots": [
            {"kind": "clip", "source": "Show", "season_episode": "S01E01",
             "visual": "a doorway", "duration_target_sec": 4}]}]

    def test_it_says_what_is_missing_and_changes_nothing(self):
        # Forced, not inferred from what happens to be installed. On a
        # machine that HAS torch this test would otherwise load the real
        # 1 GB model — downloading it on a machine that has not got it yet —
        # to prove what happens when there is no model. The suite must never
        # reach for the network, and it must test the same thing everywhere.
        with mock.patch.object(embed, "available",
                               return_value=(False, "needs torch")):
            places = [align.Placement(beat=1, shot=1, path="/fake/ep.mkv",
                                      start_ms=1234, end_ms=5234,
                                      method="interpolated")]
            rep = verify.apply(self.db, self._beats(), places)
        self.assertEqual(places[0].start_ms, 1234)
        self.assertEqual(rep.checked, 0)
        self.assertTrue(rep.reason)
        self.assertIn("pictures not checked", rep.summary())

    def test_an_unindexed_episode_is_named_rather_than_guessed_at(self):
        embed.set_backend(embed.Deterministic(dim=64))
        places = [align.Placement(beat=1, shot=1, path="/fake/ep.mkv",
                                  start_ms=1234, end_ms=5234,
                                  method="interpolated")]
        rep = verify.apply(self.db, self._beats(), places)
        self.assertEqual(places[0].start_ms, 1234)
        self.assertIn("ep.mkv", rep.runs_without_index)
        self.assertIn("Look at the footage", rep.reason)


class TestStoringWhatTheFootageLooksLike(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="visual_")
        self.db = os.path.join(self.tmp, "library.db")
        self.con = library.connect(self.db)
        self.video = os.path.join(self.tmp, "ep.mkv")
        with open(self.video, "wb") as f:
            f.write(b"not really a video, but it has a size and a date")

    def tearDown(self):
        self.con.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _store(self, backend, captions=("a", "b", "c")):
        index = fake_index(list(captions), backend=backend, path=self.video)
        os.makedirs(visual.store_dir(self.db), exist_ok=True)
        out = visual._vector_file(self.db, self.video)
        np.savez_compressed(out, times=index.times,
                            vecs=index.vecs.astype(np.float16))
        size, mtime = visual._stamp(self.video)
        self.con.execute(
            "INSERT OR REPLACE INTO visual VALUES (?,?,?,?,?,?,?,?,?)",
            (os.path.abspath(self.video), size, mtime, backend.name,
             visual.DEFAULT_FPS, len(index), index.vecs.shape[1], out, 0))
        self.con.commit()
        return index

    def test_vectors_survive_a_round_trip(self):
        backend = embed.Deterministic(dim=64)
        made = self._store(backend)
        got = visual.load(self.con, self.db, self.video)
        self.assertIsNotNone(got)
        self.assertEqual(len(got), len(made))
        np.testing.assert_allclose(got.times, made.times)
        # float16 on disk: close enough to rank identically, which is all
        # that is ever asked of it
        np.testing.assert_allclose(got.vecs, made.vecs, atol=1e-3)

    def test_vectors_live_beside_the_database_not_inside_it(self):
        self._store(embed.Deterministic(dim=64))
        self.assertTrue(os.path.isdir(visual.store_dir(self.db)))
        self.assertTrue(visual.store_dir(self.db).endswith("_visual"))

    def test_an_unindexed_video_reads_back_as_nothing(self):
        self.assertIsNone(visual.load(self.con, self.db, self.video))

    def test_a_video_already_done_is_not_done_twice(self):
        backend = embed.Deterministic(dim=64)
        self._store(backend)
        self.assertTrue(visual.is_current(self.con, self.db, self.video,
                                          backend.name))

    def test_a_changed_video_is_indexed_again(self):
        backend = embed.Deterministic(dim=64)
        self._store(backend)
        with open(self.video, "ab") as f:
            f.write(b"...now it is longer")
        self.assertFalse(visual.is_current(self.con, self.db, self.video,
                                           backend.name))

    def test_a_different_model_invalidates_the_index(self):
        # Vectors from two models are not comparable, and mixing them would
        # produce scores that look fine and mean nothing.
        self._store(embed.Deterministic(dim=64))
        self.assertFalse(visual.is_current(self.con, self.db, self.video,
                                           "google/siglip-base-patch16-224"))

    def test_a_different_sample_rate_invalidates_the_index(self):
        backend = embed.Deterministic(dim=64)
        self._store(backend)
        self.assertFalse(visual.is_current(self.con, self.db, self.video,
                                           backend.name, fps=2.0))

    def test_coverage_counts_what_is_done_against_what_is_owned(self):
        self.con.execute(
            "INSERT INTO media (path, kind, show, show_norm) VALUES (?,?,?,?)",
            (os.path.abspath(self.video), "episode", "Show", "show"))
        self.con.commit()
        self._store(embed.Deterministic(dim=64))
        self.con.commit()
        self.assertEqual(visual.coverage(self.db), (1, 1))


class TestSearchingOneEpisode(unittest.TestCase):
    def setUp(self):
        self.backend = embed.Deterministic(dim=256)
        caps = [f"filler{i}" for i in range(30)]
        caps[12] = "boxcutter"
        self.index = fake_index(caps, backend=self.backend)

    def test_the_right_frame_is_found_across_a_whole_episode(self):
        vec = self.backend.encode_texts(["boxcutter"])[0]
        m = visual.best_in(self.index, vec)
        self.assertAlmostEqual(m.time, 24.0, places=3)
        self.assertEqual(m.scope, "episode")
        self.assertTrue(m.believable)
        self.assertEqual(m.confidence, "high")

    def test_a_window_limits_the_search_but_not_the_yardstick(self):
        # Judged against the window alone, the least bad of twenty filler
        # frames would look like a match. It is judged against the episode.
        vec = self.backend.encode_texts(["boxcutter"])[0]
        m = visual.best_in(self.index, vec, lo=0.0, hi=10.0)
        self.assertEqual(m.scope, "window")
        self.assertLess(m.time, 10.1)
        self.assertFalse(m.believable)

    def test_an_empty_window_is_said_plainly(self):
        vec = self.backend.encode_texts(["boxcutter"])[0]
        m = visual.best_in(self.index, vec, lo=900.0, hi=950.0)
        self.assertFalse(m.believable)
        self.assertIn("no indexed frame", m.note)

    def test_an_empty_index_answers_rather_than_raising(self):
        empty = visual.VisualIndex(path="x", times=np.zeros(0),
                                   vecs=np.zeros((0, 64), dtype=np.float32))
        m = visual.best_in(empty, self.backend.encode_texts(["anything"])[0])
        self.assertFalse(m.believable)
        self.assertIn("nothing indexed", m.note)


class FakeTensor:
    """Just enough of a torch tensor for the unwrapping code to be tested."""

    def __init__(self, array):
        self._a = np.asarray(array)
        self.ndim = self._a.ndim

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self._a


class Pooled:
    def __init__(self, pooler_output, last_hidden_state=None):
        self.pooler_output = pooler_output
        self.last_hidden_state = last_hidden_state


class TestGettingTheEmbeddingOutOfTheModel(unittest.TestCase):
    """The one place a transformers upgrade can break this silently.

    transformers 4 returned a plain tensor from `get_image_features`;
    transformers 5 returns an output object whose embedding is
    `pooler_output`, and calling `.cpu()` on that raises AttributeError. The
    tool cannot pin the version pip resolves on someone else's machine, and
    the failure lands after a twenty-minute download.
    """

    def _unwrap(self, out):
        return embed.SigLIP._vectors(None, out)

    def test_a_plain_tensor_is_taken_as_is(self):
        got = self._unwrap(FakeTensor([[1.0, 2.0]]))
        np.testing.assert_allclose(got, [[1.0, 2.0]])

    def test_an_output_object_gives_up_its_pooler(self):
        out = Pooled(FakeTensor([[3.0, 4.0]]), FakeTensor(np.zeros((1, 7, 2))))
        np.testing.assert_allclose(self._unwrap(out), [[3.0, 4.0]])

    def test_a_tuple_yields_the_two_dimensional_member(self):
        out = (FakeTensor(np.zeros((1, 7, 2))), FakeTensor([[5.0, 6.0]]))
        np.testing.assert_allclose(self._unwrap(out), [[5.0, 6.0]])

    def test_anything_else_is_a_clear_error_not_an_attribute_error(self):
        with self.assertRaises(embed.EmbedError) as caught:
            self._unwrap({"surprise": 1})
        self.assertIn("transformers", str(caught.exception))


@unittest.skipUnless(embed.available()[0], "torch/transformers not installed")
class TestAgainstWhateverTransformersIsInstalled(unittest.TestCase):
    """Built from a config, so it needs no download and no network.

    This is the test that would have caught the `.cpu()` break. It asserts
    nothing about the quality of a real model — only that the shapes and
    return types this tool depends on are the ones the installed version of
    transformers actually produces.
    """

    def test_image_features_are_shaped_the_way_this_tool_reads_them(self):
        import torch                                          # noqa: PLC0415
        from transformers import (SiglipModel, SiglipConfig,   # noqa: PLC0415
                                  SiglipTextConfig, SiglipVisionConfig)
        cfg = SiglipConfig(
            text_config=SiglipTextConfig(
                hidden_size=32, intermediate_size=64, num_hidden_layers=1,
                num_attention_heads=2, vocab_size=64,
                max_position_embeddings=embed.TEXT_TOKENS),
            vision_config=SiglipVisionConfig(
                hidden_size=32, intermediate_size=64, num_hidden_layers=1,
                num_attention_heads=2, image_size=embed.IMAGE_SIZE,
                patch_size=16))
        model = SiglipModel(cfg).eval()
        unwrap = lambda out: embed.SigLIP._vectors(None, out)   # noqa: E731

        with torch.no_grad():
            px = torch.zeros(2, 3, embed.IMAGE_SIZE, embed.IMAGE_SIZE)
            vecs = unwrap(model.get_image_features(pixel_values=px))
            self.assertEqual(vecs.shape[0], 2)
            self.assertEqual(vecs.ndim, 2)

            ids = torch.zeros(2, embed.TEXT_TOKENS, dtype=torch.long)
            tvecs = unwrap(model.get_text_features(input_ids=ids))
            self.assertEqual(tvecs.shape, vecs.shape)

    def test_normalising_leaves_unit_rows_and_survives_a_zero_row(self):
        got = embed.unit(np.array([[3.0, 4.0], [0.0, 0.0]]))
        self.assertAlmostEqual(float(np.linalg.norm(got[0])), 1.0, places=5)
        self.assertTrue(np.all(np.isfinite(got)))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class TestReadingFramesOutOfRealFootage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="visframes_")
        cls.vid = dv.build(os.path.join(cls.tmp, "v.mkv"), log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _all(self, **kw):
        times, pixels = [], []
        for t, p in visual.frame_batches(self.vid, **kw):
            times.append(t)
            pixels.append(p)
        return np.concatenate(times), np.concatenate(pixels)

    def test_frames_arrive_at_the_asked_for_rate(self):
        times, pixels = self._all(fps=0.5)
        self.assertAlmostEqual(len(times), dv.DURATION * 0.5, delta=3)
        self.assertEqual(pixels.shape[1:], (embed.IMAGE_SIZE,
                                            embed.IMAGE_SIZE, 3))

    def test_times_are_real_seconds_in_order(self):
        times, _ = self._all(fps=0.5)
        self.assertTrue(np.all(np.diff(times) > 0))
        self.assertAlmostEqual(float(times[0]), 0.0, places=3)
        self.assertLess(float(times[-1]), dv.DURATION + 2)

    def test_the_pictures_are_the_pictures(self):
        # The demo video is one flat colour per 15-second segment, so a frame
        # at 7s must be the first colour and a frame at 22s the second.
        times, pixels = self._all(fps=0.5)
        for t, want in ((7.0, 0), (22.0, 1)):
            i = int(np.argmin(np.abs(times - t)))
            got = pixels[i].reshape(-1, 3).mean(axis=0)
            expect = dv.segment_color(want)[2]
            self.assertLess(sum(abs(a - b) for a, b in zip(got, expect)), 40,
                            f"frame at {t}s does not look like segment {want}")

    def test_stopping_early_does_not_leave_ffmpeg_running(self):
        # A caller that breaks out of the loop unwinds through the teardown.
        # If that teardown raises — or waits forever on a decoder still
        # writing — a build dies in a place nobody would think to look.
        gen = visual.frame_batches(self.vid, fps=1.0)
        next(gen)
        gen.close()

    def test_a_file_that_is_not_video_is_reported_not_crashed(self):
        bad = os.path.join(self.tmp, "notvideo.mkv")
        with open(bad, "wb") as f:
            f.write(b"nope")
        with self.assertRaises(probe.ProbeError):
            list(visual.frame_batches(bad))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class TestIndexingRealFootageEndToEnd(unittest.TestCase):
    """ffmpeg, the store, and the search, wired together with a fake model."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="visend_")
        cls.vid = dv.build(os.path.join(cls.tmp, "v.mkv"), log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.db = os.path.join(self.tmp, f"lib{id(self)}.db")
        self.con = library.connect(self.db)
        self.backend = embed.Deterministic(dim=64)

    def tearDown(self):
        self.con.close()

    def test_a_video_is_indexed_then_skipped(self):
        n = visual.index_video(self.con, self.db, self.vid,
                               backend=self.backend)
        self.assertGreater(n, 30)
        self.assertEqual(visual.index_video(self.con, self.db, self.vid,
                                            backend=self.backend), 0)

    def test_what_was_written_can_be_searched(self):
        visual.index_video(self.con, self.db, self.vid, backend=self.backend)
        index = visual.load(self.con, self.db, self.vid)
        self.assertIsNotNone(index)
        self.assertGreater(len(index), 30)
        # Real frames carry no painted caption, so the deterministic backend
        # falls back to the pixels — which is enough to prove the vectors are
        # distinct per segment rather than all the same.
        self.assertGreater(float(np.abs(np.diff(index.vecs, axis=0)).max()),
                           0.0)

    def test_forcing_a_rebuild_actually_rebuilds(self):
        visual.index_video(self.con, self.db, self.vid, backend=self.backend)
        self.assertGreater(visual.index_video(self.con, self.db, self.vid,
                                              backend=self.backend, force=True),
                           0)


if __name__ == "__main__":
    unittest.main()


class TestIndexingOnlyWhatAScriptNeeds(unittest.TestCase):
    """A five-season library is hours. One script is three episodes.

    Demanding the whole library before anyone can test one script is the
    difference between a step you run and a step you put off, so a script can
    name its own shortlist.
    """
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="only_")
        self.db = os.path.join(self.tmp, "library.db")
        con = library.connect(self.db)
        self.paths = {}
        for season, episode in ((4, 1), (4, 10), (2, 7)):
            p = f"/x/Breaking.Bad.S{season:02d}E{episode:02d}.mkv"
            self.paths[(season, episode)] = os.path.abspath(p)
            con.execute("INSERT INTO media (path, kind, show, show_norm, "
                        "season, episode) VALUES (?,?,?,?,?,?)",
                        (os.path.abspath(p), "episode", "Breaking Bad",
                         "breaking bad", season, episode))
        con.execute("INSERT INTO media (path, kind, show, show_norm) "
                    "VALUES (?,?,?,?)",
                    (os.path.abspath("/x/Heat.1995.mkv"), "movie", "Heat",
                     "heat"))
        con.commit()
        con.close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _beats(self, *declared, title="Breaking Bad"):
        return [{"beat": 1, "shots": [
            {"source": title, "season_episode": se, "visual": "a room"}
            for se in declared]}]

    def test_only_the_declared_episodes_come_back(self):
        got = visual.files_for_script(self.db, self._beats("S04E01", "S04E10"))
        self.assertEqual(sorted(got), sorted([self.paths[(4, 1)],
                                              self.paths[(4, 10)]]))

    def test_a_title_written_loosely_still_matches_the_files(self):
        got = visual.files_for_script(self.db, self._beats("S04E01"))
        self.assertEqual(got, [self.paths[(4, 1)]])

    def test_a_film_has_no_episode_to_declare_so_it_is_always_wanted(self):
        got = visual.files_for_script(self.db, self._beats("", title="Heat"))
        self.assertEqual(got, [os.path.abspath("/x/Heat.1995.mkv")])

    def test_an_episode_the_script_never_names_is_left_out(self):
        got = visual.files_for_script(self.db, self._beats("S04E01"))
        self.assertNotIn(self.paths[(2, 7)], got)

    def test_a_title_that_is_not_owned_yields_nothing_rather_than_everything(self):
        got = visual.files_for_script(
            self.db, self._beats("S01E01", title="Some Other Show"))
        self.assertEqual(got, [])

    def test_the_same_episode_named_twice_is_indexed_once(self):
        beats = self._beats("S04E01") + self._beats("S04E01")
        self.assertEqual(visual.files_for_script(self.db, beats),
                         [self.paths[(4, 1)]])


class TestARunWithNoQuotedLineAtAll(unittest.TestCase):
    """Three runs of a real script had no quoted line anywhere in them, and
    all 28 of their shots were dropped whole — while the episode was named
    in the script, sitting in the library, with its pictures already
    indexed. The dialogue was never the only evidence available.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="noquote_")
        self.db = os.path.join(self.tmp, "library.db")
        self.video = os.path.join(self.tmp, "Breaking Bad S04E08.mkv")
        with open(self.video, "wb") as f:
            f.write(b"stand-in for a real episode")
        con = library.connect(self.db)
        con.execute("INSERT INTO media (path, kind, show, show_norm, season, "
                    "episode) VALUES (?,?,?,?,?,?)",
                    (os.path.abspath(self.video), "episode", "Breaking Bad",
                     "breaking bad", 4, 8))
        con.commit()
        self.con = con
        self.backend = embed.Deterministic(dim=64)

    def tearDown(self):
        self.con.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, visuals):
        return align.Run(source="Breaking Bad", season_episode="S04E08",
                         entries=[align.Entry(beat=1, shot=i + 1, data={
                             "visual": v, "duration_target_sec": 4})
                             for i, v in enumerate(visuals)])

    def test_the_episode_is_found_without_a_line_from_it(self):
        got = align.episode_file(self.db, self._run(["a"]), con=self.con)
        self.assertEqual(got, os.path.abspath(self.video))

    def test_an_episode_that_is_not_owned_resolves_to_nothing(self):
        run = align.Run(source="Breaking Bad", season_episode="S09E99",
                        entries=[])
        self.assertEqual(align.episode_file(self.db, run, con=self.con), "")

    def test_a_run_with_no_episode_named_resolves_to_nothing(self):
        run = align.Run(source="Breaking Bad", season_episode="unknown",
                        entries=[])
        self.assertEqual(align.episode_file(self.db, run, con=self.con), "")

    def test_it_is_handed_on_unplaced_rather_than_dropped(self):
        placements = align.align_run(self.db, self._run(["doorway", "apron"]),
                                     con=self.con)
        self.assertEqual(len(placements), 2)
        for p in placements:
            self.assertEqual(p.path, os.path.abspath(self.video))
            # Still "none": nothing has looked yet, and cutting from a
            # position nobody checked is the failure this all exists to end.
            self.assertEqual(p.method, "none")
            self.assertIn("picture only", p.note)

    def test_the_pictures_then_place_it(self):
        caps = [f"filler{i}" for i in range(20)]
        caps[4], caps[12] = "doorway", "apron"
        index = fake_index(caps, backend=self.backend,
                           path=os.path.abspath(self.video))
        run = self._run(["doorway", "apron"])
        places = align.align_run(self.db, run, con=self.con)
        verify.verify_run(index, run, places, self.backend)
        self.assertEqual([p.start_ms for p in places], [8000, 24000])
        self.assertTrue(all(p.method == "verified" for p in places))

    def test_an_even_spread_is_not_mistaken_for_a_prior(self):
        # The invented starting positions must not pull anything. If they
        # did, a run with no anchor would settle wherever the spread put it
        # rather than wherever the pictures are.
        caps = [f"filler{i}" for i in range(40)]
        caps[35], caps[37] = "doorway", "apron"
        index = fake_index(caps, backend=self.backend,
                           path=os.path.abspath(self.video))
        run = self._run(["doorway", "apron"])
        places = align.align_run(self.db, run, con=self.con)
        verify.verify_run(index, run, places, self.backend)
        self.assertEqual([p.start_ms for p in places], [70000, 74000])

    def test_a_run_the_pictures_cannot_place_either_stays_unplaced(self):
        # No dialogue AND no picture is not "somewhere in the middle". It is
        # not known, and cutting anyway would be inventing a position.
        index = fake_index([f"filler{i}" for i in range(20)],
                           backend=self.backend,
                           path=os.path.abspath(self.video))
        run = self._run(["nothinglikethis", "norlikethat"])
        places = align.align_run(self.db, run, con=self.con)
        verify.verify_run(index, run, places, self.backend)
        self.assertTrue(all(p.method == "none" for p in places))

    def test_the_gate_counts_it_once_the_pictures_exist(self):
        beats = [{"beat": 1, "shots": [
            {"source": "Breaking Bad", "season_episode": "S04E08",
             "visual": "a doorway", "duration_target_sec": 4},
            {"source": "Breaking Bad", "season_episode": "S04E08",
             "visual": "an apron", "duration_target_sec": 4}]}]
        self.assertEqual(align.placeable(self.db, beats), (0, 2))

        index = fake_index([f"w{i}" for i in range(20)], backend=self.backend,
                           path=os.path.abspath(self.video))
        os.makedirs(visual.store_dir(self.db), exist_ok=True)
        out = visual._vector_file(self.db, self.video)
        np.savez_compressed(out, times=index.times,
                            vecs=index.vecs.astype(np.float16))
        size, mtime = visual._stamp(self.video)
        self.con.execute(
            "INSERT OR REPLACE INTO visual VALUES (?,?,?,?,?,?,?,?,?)",
            (os.path.abspath(self.video), size, mtime, self.backend.name,
             visual.DEFAULT_FPS, len(index), index.vecs.shape[1], out, 0))
        self.con.commit()
        self.assertEqual(align.placeable(self.db, beats), (2, 2))


class TestSayingWhichFixIsNeeded(unittest.TestCase):
    """A low score has two opposite causes that look identical in a report.

    Either the model never found the picture — which is fixed by writing a
    better description — or it found it and the ordering constraint gave
    that frame to a neighbour, which is not the description's fault at all.
    A build that cannot tell those apart cannot be acted on.
    """

    def setUp(self):
        self.backend = embed.Deterministic(dim=64)

    def _run(self, visuals):
        return align.Run(source="S", season_episode="S01E01", entries=[
            align.Entry(beat=1, shot=i + 1,
                        data={"visual": v, "duration_target_sec": 4})
            for i, v in enumerate(visuals)])

    def test_a_shot_that_lost_its_frame_to_a_neighbour_is_marked_as_such(self):
        # Two shots describe the same moment; only one can have it. The
        # loser's description was not the problem, and saying it was would
        # send the writer off to rewrite a caption that already worked.
        caps = [f"filler{i}" for i in range(40)]
        caps[10], caps[25] = "boxcutter", "apron"
        index = fake_index(caps, backend=self.backend)
        run = self._run(["boxcutter", "boxcutter", "apron"])
        places = [align.Placement(beat=1, shot=i + 1, path=index.path,
                                  start_ms=1000, end_ms=5000,
                                  method="interpolated") for i in range(3)]
        verdicts = verify.verify_run(index, run, places, self.backend)
        loser = [v for v in verdicts[:2] if v.lift < visual.LIFT_OK]
        self.assertTrue(loser, "expected one of the two to lose the frame")
        self.assertTrue(loser[0].lost_to_ordering)

    def test_a_shot_that_matched_nothing_anywhere_is_not_blamed_on_ordering(self):
        index = fake_index([f"filler{i}" for i in range(40)],
                           backend=self.backend)
        run = self._run(["utterlyunrelated", "alsounrelated", "andathird"])
        places = [align.Placement(beat=1, shot=i + 1, path=index.path,
                                  start_ms=1000, end_ms=5000,
                                  method="interpolated") for i in range(3)]
        verdicts = verify.verify_run(index, run, places, self.backend)
        for v in verdicts:
            if v.best < visual.LIFT_OK:
                self.assertFalse(v.lost_to_ordering,
                                 "a shot with no match anywhere cannot have "
                                 "lost one to the ordering")

    def test_the_two_halves_of_the_diagnosis_are_both_required(self):
        # Winning a lottery over 1,400 frames is not a match; beating rivals
        # at a frame nobody matched is not one either.
        lottery = verify.Verdict(beat=1, shot=1, best=9.0, distinct=False,
                                 lift=0.1)
        hollow = verify.Verdict(beat=1, shot=2, best=0.2, distinct=True,
                                lift=0.1)
        real = verify.Verdict(beat=1, shot=3, best=3.0, distinct=True,
                              lift=0.1)
        self.assertFalse(lottery.lost_to_ordering)
        self.assertFalse(hollow.lost_to_ordering)
        self.assertTrue(real.lost_to_ordering)

    def test_a_run_too_short_to_compare_claims_nothing(self):
        # Two captions cannot tell you whether either is distinctive.
        index = fake_index([f"filler{i}" for i in range(40)],
                           backend=self.backend)
        run = self._run(["boxcutter", "apron"])
        places = [align.Placement(beat=1, shot=i + 1, path=index.path,
                                  start_ms=1000, end_ms=5000,
                                  method="interpolated") for i in range(2)]
        for v in verify.verify_run(index, run, places, self.backend):
            self.assertFalse(v.distinct)

    def test_the_summary_names_the_fix(self):
        rep = verify.Report(checked=10, unmatched=6, lost_to_ordering=4)
        text = rep.summary()
        self.assertIn("4 did have a match elsewhere", text)
        self.assertIn("2 matched nothing anywhere", text)
