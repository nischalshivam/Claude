# HANDOFF — how to use these files

You have a complete record of this project (TOOL #2: Auto Editor).

## To make changes / add features (give it to an LLM)
1. Open a new chat with Claude / ChatGPT / Gemini.
2. Attach BOTH:
   - `00_PROJECT_HANDOFF.md` (the full story, needs, decisions, limits)
   - `01_TECHNICAL_REFERENCE.md` (the code map + Filmora format + extension points)
3. If the change touches code, also attach the specific file(s) mentioned.
4. Tell it what you want, e.g.:
   - "Add a background music track at 20% volume."
   - "Support my new Filmora 16 — here's a fresh sample bundle."
   - "Make scene transitions random from the available list."
5. Ask it to test with `--dry-run`, then `verify_bundle.py`, then open in Filmora.

## To fix a bug
Paste the FULL error/traceback + what you were doing. If Filmora refuses to
open a generated file, ALSO save a fresh tiny sample project from your Filmora
and attach it — the LLM will diff the formats.

## To regenerate a video project (normal use)
See `../SETUP_GUIDE.md`. Short version: run.bat → pick footage folder, audio,
instructor file → Generate → double-click the .wfpbundle.

## IMPORTANT: the sample project (template)
This tool writes Filmora files by copying structures from a sample project
saved by YOUR Filmora (currently 15.6.4, stored as
`template_data/filmora_15_6_4.json`). If you upgrade Filmora and projects stop
opening: make a tiny sample project in the new Filmora (2 clips + image with
animation + transition + one title), save it, and run:
`python -m filmora.template YourSample.wfpbundle template_data/filmora_new.json`
then use it via `--template` (or replace the default file).

## File map (what to read first)
1. `00_PROJECT_HANDOFF.md` — start here.
2. `01_TECHNICAL_REFERENCE.md` — the code + Filmora format.
3. `../SETUP_GUIDE.md` — usage.
