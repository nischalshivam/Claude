"""Static checks on the Windows .bat files.

These cannot be executed here, so they are linted instead. Every rule below
exists because the mistake it catches is silent on Windows: the script does
not error, it just quietly does the wrong thing — which is far worse than a
crash for someone who is not going to read a batch file to find out why.
"""
from __future__ import annotations

import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BATS = ["setup.bat", "start.bat", "check.bat", "mi.bat"]


def read(name: str) -> str:
    with open(os.path.join(ROOT, name), "rb") as f:
        return f.read().decode("utf-8")


def read_bytes(name: str) -> bytes:
    with open(os.path.join(ROOT, name), "rb") as f:
        return f.read()


def code_only(line: str) -> str:
    """Drop the parts of a line that cannot delimit a block.

    A caret escapes the next character, so `echo 1^)` prints a literal ")"
    and must not be counted as closing an if-block.
    """
    line = re.sub(r"\^.", "", line)          # caret-escaped literals
    return re.sub(r'"[^"]*"', "", line)       # quoted strings


class TestBatchFiles(unittest.TestCase):
    def test_all_present(self):
        for name in BATS:
            self.assertTrue(os.path.isfile(os.path.join(ROOT, name)), name)

    def test_line_endings_are_crlf(self):
        """LF-only .bat files make labels and goto unreliable on Windows."""
        for name in BATS:
            raw = read_bytes(name)
            bare = raw.count(b"\n") - raw.count(b"\r\n")
            self.assertEqual(bare, 0, f"{name} has {bare} bare LF endings")

    def test_every_goto_and_call_target_exists(self):
        for name in BATS:
            text = read(name).replace("\r\n", "\n")
            labels = set(re.findall(r"(?m)^:(\w+)", text))
            targets = (set(re.findall(r"(?im)\bgoto\s+(\w+)", text))
                       | set(re.findall(r"(?im)\bcall\s+:(\w+)", text)))
            missing = targets - labels - {"eof"}
            self.assertEqual(missing, set(), f"{name} jumps to missing {missing}")

    def test_parentheses_balance(self):
        for name in BATS:
            depth = 0
            for i, line in enumerate(read(name).splitlines(), 1):
                code = code_only(line)
                depth += code.count("(") - code.count(")")
                self.assertGreaterEqual(depth, 0, f"{name}:{i} closes too many")
            self.assertEqual(depth, 0, f"{name} leaves {depth} block(s) open")

    def test_no_quote_stripping_trap(self):
        """set "X=!X:"=!" looks right and does not parse; the unquoted form is
        the one that actually strips quotes from a dragged-in path."""
        for name in BATS:
            self.assertNotRegex(read(name), r'set\s+"\w+=![^!]+:"=!"',
                                f"{name} uses the quoted :\"=! form")

    def test_no_trailing_backslash_in_exist_test(self):
        """if exist "%DIR%\\" can be read as an escaped quote; use "%DIR%\\."."""
        for name in BATS:
            self.assertNotRegex(read(name), r'if\s+(?:not\s+)?exist\s+"[^"]*\\"',
                                f"{name} ends an exist path with a backslash")

    def test_delayed_expansion_enabled_where_it_is_used(self):
        """A ! variable inside a block silently expands to nothing without it."""
        for name in BATS:
            text = read(name)
            uses_bang = re.search(r"![A-Za-z_]\w*!", text)
            if uses_bang:
                self.assertIn("EnableDelayedExpansion", text,
                              f"{name} uses !VAR! without enabling it")

    def test_each_script_pins_its_own_directory(self):
        """Double-clicking runs with an arbitrary working directory."""
        for name in BATS:
            self.assertIn('cd /d "%~dp0"', read(name), name)

    def test_console_is_switched_to_utf8(self):
        """Otherwise cmd.exe renders correct UTF-8 output as mojibake."""
        for name in BATS:
            self.assertIn("chcp 65001", read(name), name)

    def test_python_detection_tests_errorlevel_explicitly(self):
        """`if not defined PY where py && set ...` does not parse as it reads."""
        for name in BATS:
            text = read(name)
            if "where python" not in text:
                continue
            self.assertNotRegex(
                text, r"if\s+not\s+defined\s+PY\s+where\s+\w+.*&&",
                f"{name} uses the one-line detection form that misparses")
            self.assertIn("%errorlevel%==0", text, name)

    def test_menu_offers_every_stage_of_the_workflow(self):
        text = read("start.bat")
        for cmd in ("check", "transcribe", "build", "find", "stats", "run"):
            self.assertIn(f"media_index {cmd}", text,
                          f"start.bat never runs '{cmd}'")

    def test_menu_choices_all_have_a_destination(self):
        text = read("start.bat").replace("\r\n", "\n")
        offered = set(re.findall(r'(?m)^\s*echo\s+(\d+)\.', text))
        routed = set(re.findall(r'if\s+"!CHOICE!"=="(\d+)"', text))
        self.assertTrue(offered, "no numbered options found")
        self.assertEqual(offered - routed, set(),
                         f"menu offers {offered - routed} with no handler")


if __name__ == "__main__":
    unittest.main(verbosity=2)
