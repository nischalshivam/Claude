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
BATS = ["setup.bat", "start.bat", "check.bat", "mi.bat", "update.bat"]


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

    def test_quote_stripping_uses_the_quoted_assignment_form(self):
        """Stripping the quotes a drag-and-drop adds has exactly one safe form.

        `set "DIR=!DIR:"=!"` is safe: delayed expansion happens after the line
        is parsed, so the substitution never reaches the parser, and the outer
        quotes stop a trailing space from being kept.

        The bare form, `set DIR=!DIR:"=!`, keeps whatever whitespace `set /p`
        collected. Passing the value to a helper as `call :unquote DIR !DIR!`
        is worse still: an unquoted path with spaces arrives as several
        arguments and only the first word survives.
        """
        ok = re.compile(r'(?m)^\s*(?:if\s+defined\s+\w+\s+)?'
                        r'set\s+"(\w+)=!\1:"=!"\s*$')
        for name in BATS:
            for i, line in enumerate(read(name).splitlines(), 1):
                if ':"=!' not in line:
                    continue
                self.assertRegex(line, ok,
                                 f'{name}:{i} strips quotes unsafely')

    def test_no_duplicate_labels(self):
        """cmd jumps to the FIRST match, so a duplicated label silently runs
        the wrong code — and a bad edit that pastes a block over a `call` line
        produces exactly that."""
        for name in BATS:
            labels = re.findall(r"(?m)^:(\w+)", read(name))
            dupes = {l for l in labels if labels.count(l) > 1}
            self.assertEqual(dupes, set(), f"{name} defines {dupes} twice")

    def test_every_menu_handler_returns_to_the_menu(self):
        """A handler that ends in `exit /b` closes the whole window.

        `exit /b` only returns from a subroutine when it was reached by
        `call`. A `:do_*` block is reached by `goto`, so there is nothing to
        return to and the script ends — the window vanishes mid-session with
        no message.
        """
        text = read("start.bat").replace("\r\n", "\n")
        blocks = re.split(r"(?m)^:(\w+)\s*$", text)[1:]
        for label, body in zip(blocks[::2], blocks[1::2]):
            if not label.startswith("do_"):
                continue
            self.assertIn("goto menu", body,
                          f":{label} never returns to the menu")
            self.assertNotRegex(body, r"(?im)^\s*exit\s+/b",
                                f":{label} ends the script instead of "
                                "returning to the menu")

    def test_subroutines_taking_arguments_are_always_given_them(self):
        """`call :helper` with no argument makes `set "%~1=%~2"` read as
        `set "="`, which prints 'The syntax of the command is incorrect.'"""
        for name in BATS:
            text = read(name).replace("\r\n", "\n")
            blocks = re.split(r"(?m)^:(\w+)\s*$", text)[1:]
            takes_args = {label for label, body in zip(blocks[::2], blocks[1::2])
                          if re.search(r"%~[1-9]", body)}
            for label in takes_args:
                for m in re.finditer(rf"(?im)\bcall\s+:{label}\b(.*)$", text):
                    self.assertTrue(m.group(1).strip(),
                                    f"{name} calls :{label} with no argument")

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
        # "cut" is on this list because watching the clip is the only step
        # that proves the chain end to end. A search score says the text
        # matched; it says nothing about whether the timing is right.
        #
        # "sheet" is here for the same reason one level up: a video's worth of
        # stills can only be judged side by side, and a build with no review
        # step is how wrong footage reached finished videos before.
        #
        # "run" — the overnight queue — is deliberately not on the menu. It
        # takes a job file describing many videos, and typing that path is
        # not the thing to put in front of someone testing one script. It
        # stays available as `mi.bat run jobs.json`.
        for cmd in ("check", "transcribe", "build", "find", "cut", "stats",
                    "make", "sheet"):
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
