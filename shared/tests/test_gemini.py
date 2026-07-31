"""The vision verifier's offline half: config, prompt, parse — no network.

The one thing local retrieval cannot do is look at a frame, so the model
call itself cannot be unit-tested here and is deliberately isolated. What
CAN be tested is everything around it: that a secret only ever comes from
settings or environment and never from code, that the prompt numbers frames
so the answer maps back to a real timestamp, and that a mangled or abstaining
verdict is read as "no opinion" rather than moving a shot on nonsense.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import gemini                             # noqa: E402


def frames(*times):
    return [gemini.Frame(at_s=t, jpeg=b"\xff\xd8jpeg") for t in times]


class TestConfigNeverComesFromCode(unittest.TestCase):

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in
                       ("GEMINI_API_KEY", "GEMINI_BASE_URL", "GEMINI_MODEL")}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_environment_supplies_the_key(self):
        os.environ["GEMINI_API_KEY"] = "sk-test"
        os.environ["GEMINI_BASE_URL"] = "https://x/v1"
        cfg = gemini.config()
        self.assertEqual(cfg.key, "sk-test")
        self.assertTrue(cfg.ok)
        self.assertEqual(cfg.endpoint, "https://x/v1/chat/completions")

    def test_no_key_is_not_ok_and_says_why(self):
        ok, why = gemini.available()
        self.assertFalse(ok)
        self.assertIn("gemini_key", why)

    def test_the_default_model_is_flash(self):
        self.assertEqual(gemini.Config(key="k", base="b").model,
                         gemini.DEFAULT_MODEL)

    def test_no_key_literal_is_committed_in_the_source(self):
        """A pasted key must never end up in the repository."""
        with open(gemini.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("sk-", src)


class TestTheQuestion(unittest.TestCase):

    def test_frames_are_numbered_so_the_answer_maps_back(self):
        msgs = gemini.build_messages("a bell is struck", ["Hector"],
                                     frames(10.0, 20.0, 30.0))
        user = msgs[1]["content"]
        texts = [c["text"] for c in user if c["type"] == "text"]
        self.assertTrue(any("Frame 1:" in t for t in texts))
        self.assertTrue(any("Frame 3:" in t for t in texts))
        self.assertTrue(any("Hector" in t for t in texts))
        images = [c for c in user if c["type"] == "image_url"]
        self.assertEqual(len(images), 3)
        self.assertTrue(images[0]["image_url"]["url"].startswith(
            "data:image/jpeg;base64,"))

    def test_the_system_rule_allows_an_abstention(self):
        msgs = gemini.build_messages("x", [], frames(1.0))
        self.assertIn("-1", msgs[0]["content"])


class TestTheAnswer(unittest.TestCase):

    def test_a_clean_verdict_maps_to_the_frames_timestamp(self):
        fr = frames(10.0, 20.0, 30.0)
        ch = gemini.parse_verdict(
            '{"frame": 2, "confidence": 0.9, "reason": "bell visible"}', fr)
        self.assertTrue(ch.chose)
        self.assertEqual(ch.at_s, 20.0)
        self.assertEqual(ch.index, 1)

    def test_a_fenced_verdict_is_still_read(self):
        fr = frames(5.0, 6.0)
        ch = gemini.parse_verdict(
            'Here you go:\n```json\n{"frame": 1, "confidence": 0.8}\n```', fr)
        self.assertTrue(ch.chose)
        self.assertEqual(ch.at_s, 5.0)

    def test_frame_minus_one_is_an_honest_abstention(self):
        ch = gemini.parse_verdict('{"frame": -1, "confidence": 0.0}',
                                  frames(1.0, 2.0))
        self.assertFalse(ch.chose)
        self.assertEqual(ch.index, -1)

    def test_low_confidence_does_not_move_a_shot(self):
        ch = gemini.parse_verdict('{"frame": 1, "confidence": 0.3}',
                                  frames(1.0, 2.0))
        self.assertFalse(ch.chose)

    def test_a_frame_number_out_of_range_is_refused(self):
        ch = gemini.parse_verdict('{"frame": 9, "confidence": 0.9}',
                                  frames(1.0, 2.0))
        self.assertFalse(ch.chose)
        self.assertEqual(ch.index, -1)

    def test_garbage_is_no_opinion_not_a_crash(self):
        for bad in ("", "not json", "{", '{"frame":', "null"):
            ch = gemini.parse_verdict(bad, frames(1.0))
            self.assertFalse(ch.chose)

    def test_verify_without_config_returns_no_choice(self):
        saved = {k: os.environ.pop(k, None) for k in
                 ("GEMINI_API_KEY", "GEMINI_BASE_URL")}
        try:
            ch = gemini.verify("x", frames(1.0, 2.0),
                               cfg=gemini.Config())    # empty config
            self.assertFalse(ch.chose)
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v


if __name__ == "__main__":
    unittest.main()
