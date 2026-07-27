"""Tests for the tool in a browser.

Six builds were spent describing pictures to each other in text — a shot
from the wrong scene, a still that sat too long — when a single glance would
have settled any of them. This is the glance.

The page itself is not tested here; what is tested is everything a wrong
answer would come from: the join between the manifest and the timeline, the
refusal to hand out files it was not asked for, and the fact that a missing
folder is an answer rather than a stack trace.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media_index import web                                   # noqa: E402


def _write(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f)


class _Built(unittest.TestCase):
    """An output folder shaped exactly like one the menu writes."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="web_")
        os.makedirs(os.path.join(self.tmp, "scene_001"))
        with open(os.path.join(self.tmp, "scene_001", "image_01_1.jpg"),
                  "wb") as f:
            f.write(b"\xff\xd8\xff\xdb" + b"x" * 64)
        _write(os.path.join(self.tmp, "manifest.json"), {
            "video": "gus4.json",
            "scenes": [{"scene": 1, "assets": [
                {"file": "image_01_1.jpg", "kind": "image",
                 "placed_by": "anchor", "source_start": 2232.5,
                 "source": "Breaking Bad Season 4 Episode 1.mp4"},
                {"file": "clip_01.mp4", "kind": "video",
                 "placed_by": "filler", "source_start": 376.6,
                 "source": "Breaking Bad Season 3 Episode 13.mp4"}]}]})
        _write(os.path.join(self.tmp, "timeline.json"), {
            "video": "gus4.json", "total_seconds": 669.08, "pace": "normal",
            "scenes": [
                {"scene": 1, "narration": "A man walks in.", "start": 0.0,
                 "end": 5.5, "items": [
                     {"file": "image_01_1.jpg", "kind": "image", "start": 0.0,
                      "duration": 5.5, "placed_by": "anchor",
                      "source": "Breaking Bad Season 4 Episode 1.mp4",
                      "source_start": 2232.5, "confidence": "high"}]},
                {"scene": 2, "narration": "Nothing here.", "start": 5.5,
                 "end": 9.0, "note": "nothing to show here", "items": []}]})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestWhatOneFolderKnows(_Built):
    def test_the_manifest_and_the_timeline_are_joined(self):
        """Neither is complete alone: one says what was cut and where from,
        the other says when it is on screen. Joining them in the page would
        put a mistake somewhere nobody can see it."""
        b = web.build_folder(self.tmp)
        item = b["scenes"][0]["items"][0]
        self.assertEqual(item["placed_by"], "anchor")
        self.assertEqual(item["source_start"], 2232.5)
        self.assertIn("Episode 1", item["source"])
        self.assertAlmostEqual(b["total_seconds"], 669.08)

    def test_how_each_shot_got_there_is_counted(self):
        b = web.build_folder(self.tmp)
        self.assertEqual(b["counts"], {"anchor": 1})

    def test_a_beat_with_nothing_is_kept_and_counted(self):
        # Deleting empty beats from the page would hide the one thing the
        # editor most needs to see.
        b = web.build_folder(self.tmp)
        self.assertEqual(len(b["scenes"]), 2)
        self.assertEqual(b["scenes"][1]["items"], [])
        self.assertEqual(b["empty"], 1)

    def test_an_unrendered_folder_says_so_rather_than_linking_nothing(self):
        self.assertEqual(web.build_folder(self.tmp)["rendered"], "")
        open(os.path.join(self.tmp, "video.mp4"), "wb").close()
        self.assertTrue(web.build_folder(self.tmp)["rendered"])

    def test_an_empty_folder_is_an_answer_not_a_crash(self):
        blank = tempfile.mkdtemp(prefix="web_blank_")
        try:
            b = web.build_folder(blank)
            self.assertEqual(b["scenes"], [])
            self.assertFalse(b["has_manifest"])
        finally:
            shutil.rmtree(blank, ignore_errors=True)


class TestTheServer(_Built):
    _next_port = 8830

    def setUp(self):
        super().setUp()
        # A distinct port per test, walked forward rather than searched for.
        # Every server started here lives until the process ends, so asking
        # "what is free?" races the previous test's server still binding —
        # which showed up as a stack trace beside a passing run.
        TestTheServer._next_port += 1
        self.port = web.free_port(TestTheServer._next_port)
        self.thread = threading.Thread(
            target=web.serve,
            kwargs=dict(db_path=os.path.join(self.tmp, "library.db"),
                        out=self.tmp, port=self.port, open_browser=False,
                        log=lambda *a: None),
            daemon=True)
        self.thread.start()
        time.sleep(0.4)

    def _get(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}",
                                    timeout=5) as r:
            return r.status, r.read()

    def _status(self, path):
        try:
            return self._get(path)[0]
        except urllib.error.HTTPError as exc:
            return exc.code

    def test_the_page_is_served(self):
        code, body = self._get("/")
        self.assertEqual(code, 200)
        self.assertIn(b"media_index", body)

    def test_a_folder_can_be_read_over_http(self):
        code, body = self._get(
            "/api/build?out=" + urllib.parse.quote(self.tmp))
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["counts"], {"anchor": 1})

    def test_a_still_is_served_from_inside_the_folder(self):
        b = web.build_folder(self.tmp)
        code, body = self._get(b["scenes"][0]["items"][0]["url"])
        self.assertEqual(code, 200)
        self.assertTrue(body.startswith(b"\xff\xd8"))

    def test_it_will_not_hand_out_anything_above_the_folder(self):
        """A local server is still a server. `rel` is attacker-shaped input
        the moment anything else on the machine can reach the port."""
        out = urllib.parse.quote(self.tmp)
        self.assertEqual(self._status(f"/file?out={out}&rel=../../etc/passwd"),
                         403)
        self.assertEqual(self._status(f"/file?out={out}&rel=..%2Fmanifest.json"),
                         403)

    def test_it_will_not_hand_out_a_database_even_from_inside(self):
        open(os.path.join(self.tmp, "library.db"), "wb").close()
        out = urllib.parse.quote(self.tmp)
        self.assertEqual(self._status(f"/file?out={out}&rel=library.db"), 403)

    def test_a_folder_that_is_not_there_is_named(self):
        self.assertEqual(self._status("/api/build?out=/definitely/not/here"),
                         404)

    def test_the_app_is_what_opens_and_the_old_page_is_still_there(self):
        """The shot-by-shot page has worked since the sixth build. Taking it
        away to show a half-built app would be a downgrade dressed as one."""
        code, body = self._get("/")
        self.assertEqual(code, 200)
        self.assertIn(b"Movie Editor", body)
        code, body = self._get("/shots")
        self.assertEqual(code, 200)
        self.assertIn(b"media_index", body)

    def test_the_app_can_fetch_its_own_parts(self):
        for path, needle in (("/ui/dcx.js", b"DCX"),
                             ("/ui/app.js", b"api/titles"),
                             ("/ui/screens", b"Library."),
                             ("/ui/design", b"data-theme")):
            code, body = self._get(path)
            self.assertEqual(code, 200, path)
            self.assertIn(needle, body, path)

    def test_ui_serves_a_fixed_list_and_not_whatever_the_url_asks_for(self):
        """`/ui/` reaches into the package itself. A route that took a file
        name from the URL would read the source — or anything else — out of
        a browser tab."""
        for asked in ("web.py", "../web.py", "..%2Flibrary.db", "app.html"):
            self.assertEqual(self._status("/ui/" + asked), 404, asked)

    def test_the_titles_a_library_holds_are_served(self):
        code, body = self._get("/api/titles")
        self.assertEqual(code, 200)
        data = json.loads(body)
        self.assertIn("titles", data)
        self.assertIn("counts", data)

    def test_a_missing_database_is_reported_rather_than_raised(self):
        code, body = self._get("/api/library")
        self.assertEqual(code, 200)
        self.assertIn("db", json.loads(body))


class TestItNeedsNothingInstalled(unittest.TestCase):
    """The tool installs from a zip onto a Windows machine with no build
    tools. A page that needs `pip install` before it opens is a page nobody
    will ever see."""

    def test_the_server_imports_only_the_standard_library(self):
        import ast
        src = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "media_index", "web.py")
        with open(src, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        outside = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                outside |= {n.name.split(".")[0] for n in node.names}
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                outside.add((node.module or "").split(".")[0])
        allowed = set(sys.stdlib_module_names) | {"", "media_index"}
        self.assertFalse(outside - allowed, f"needs {outside - allowed}")

    def test_the_page_carries_its_own_styling_and_script(self):
        page = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "media_index", "web_ui.html")
        with open(page, encoding="utf-8") as f:
            html = f.read()
        self.assertNotIn("http://", html.split("<script>")[0])
        self.assertNotIn("https://", html)
        self.assertIn("<style>", html)
        self.assertIn("<script>", html)


class TestTheAppsOwnFiles(unittest.TestCase):
    """The page is HTML holding names, and JavaScript holding values. When
    the two disagree the screen does not break — it quietly shows a blank
    where a number should be, which is the worst way for a tool that reports
    numbers to be wrong. So they are checked against each other here."""

    def _read(self, *parts):
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(base, "media_index", *parts),
                  encoding="utf-8") as f:
            return f.read()

    def test_every_name_the_screens_ask_for_is_one_the_app_supplies(self):
        import re
        screens = self._read("ui", "screens.html")
        app = self._read("ui", "app.js")
        asked = set()
        for raw in re.findall(r"\{\{([^}]*)\}\}", screens):
            head = raw.strip().split(".")[0]
            if head and not re.match(r"^(true|false|-?\d)", head):
                asked.add(head)
        # `sc-for` introduces its own name for each item; that name is bound
        # by the renderer, not by app.js.
        asked -= set(re.findall(r'<sc-for[^>]*as="([^"]+)"', screens))
        missing = sorted(n for n in asked
                         if not re.search(r"\b" + re.escape(n) + r"\s*:", app))
        self.assertFalse(missing, f"screens.html asks for {missing}")

    def test_the_page_pulls_nothing_off_the_internet(self):
        """The machine this runs on may have no internet at all, and the one
        thing worse than a page that needs `npm` is a page that looks fine
        here and is unstyled there."""
        import re
        for name in ("app.html", "app.js", "dcx.js", "screens.html"):
            text = self._read("ui", name)
            self.assertNotIn("https://", text, name)
            # http:// appears legitimately in exactly one place: the XML
            # namespace names, which are identifiers and never fetched.
            for url in re.findall(r"http://[^\s\"'`]+", text):
                self.assertTrue(url.startswith("http://www.w3.org/"),
                                f"{name} reaches for {url}")
            for banned in ("cdn.", "unpkg", "googleapis", "import React"):
                self.assertNotIn(banned, text, f"{name} reaches for {banned}")

    def test_the_design_it_is_built_against_is_in_the_repository(self):
        """A page whose colours live in a file nobody committed is a page
        that works on one machine."""
        self.assertTrue(os.path.isfile(web.DESIGN), web.DESIGN)


if __name__ == "__main__":
    unittest.main(verbosity=2)
