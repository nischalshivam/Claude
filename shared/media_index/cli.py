"""Command line for the dialogue index.

    python -m media_index build  D:/Media --db library.db
    python -m media_index find   "I never wanted the harvest" --db library.db
    python -m media_index stats  --db library.db
    python -m media_index resolve script.json --db library.db
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import (align, contact, cutter, doctor, embed, frames, jobs as jobs_mod,
               library, runner, search, sources, subs, subtitles, sync,
               term, transcribe, visual)


def _fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} GB"


def cmd_build(a):
    res = library.build(a.media_dir, a.db, verify_sync=a.verify_sync,
                        sync_seconds=a.sync_seconds)
    print("")
    print(f"  added {res.added} · updated {res.updated} · skipped {res.skipped}")
    print(f"  {res.cues:,} dialogue lines indexed in {res.seconds:.1f}s")
    if res.no_subs:
        print(f"\n  ⚠ {len(res.no_subs)} file(s) with no usable subtitles:")
        for p, why in res.no_subs[:20]:
            print(f"      {os.path.basename(p)}  —  {why}")
    if res.desynced:
        print(f"\n  {len(res.desynced)} file(s) had their subtitles shifted:")
        for p, why in res.desynced[:20]:
            print(f"      {os.path.basename(p)}  —  {why}")
    st = library.stats(a.db)
    print(f"\n  library.db = {_fmt_bytes(st['db_bytes'])}")
    return 0


def cmd_stats(a):
    st = library.stats(a.db)
    print(f"files          {st['media_files']}  "
          f"({st['with_subs']} with subs, {st['without_subs']} without)")
    print(f"titles         {st['shows']}")
    print(f"dialogue lines {st['dialogue_lines']:,}")
    print(f"db size        {_fmt_bytes(st['db_bytes'])}")
    print("")
    for t in st["titles"]:
        seasons = ""
        if t["kind"] == "episode" and t["s_min"] is not None:
            seasons = (f"  S{t['s_min']:02d}"
                       + (f"-S{t['s_max']:02d}" if t["s_max"] != t["s_min"] else ""))
        print(f"  {t['show']:<40} {t['files']:>3} file(s){seasons}"
              f"   {t['lines'] or 0:>6,} lines")
    return 0


def cmd_find(a):
    hits = search.find(a.db, a.quote, show=a.show, season=a.season,
                       episode=a.episode, limit=a.limit)
    if not hits:
        print("no match")
        return 1
    print(f'query: "{a.quote}"\n')
    for i, h in enumerate(hits, 1):
        mark = {"high": term.sym("yes"), "medium": term.sym("maybe"),
                "low": term.sym("no")}[h.confidence]
        a0, b0 = h.cut_window()
        print(f"{mark} {i}. {h.label}   {h.timecode}   "
              f"score {h.score:.0f}  cov {h.coverage:.0%}  [{h.confidence}]")
        print(f'      "{h.matched_text}"')
        print(f"      cut {a0/1000:.1f}s → {b0/1000:.1f}s   {os.path.basename(h.path)}")
    return 0


def cmd_resolve(a):
    with open(a.script, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    beats = data if isinstance(data, list) else data.get("beats", [])
    rows = search.resolve_script(a.db, beats)

    icon = {"resolved": term.sym("ok"), "ambiguous": term.sym("warn"),
            "weak": term.sym("warn"), "not_found": term.sym("fail"),
            "no_query": term.sym("blank")}
    counts = {}
    print(f"{'beat':>5} {'':3} {'where':<34} {'time':>12}  detail")
    print("-" * 92)
    for r in rows:
        counts[r.status] = counts.get(r.status, 0) + 1
        where = r.hit.label if r.hit else "—"
        when = r.hit.timecode if r.hit else "—"
        extra = r.note or (f"score {r.hit.score:.0f}" if r.hit else "")
        print(f"{r.beat:>5}.{r.shot} {icon[r.status]} {where:<34} {when:>12}  {extra}")

    total = len(rows)
    ok = counts.get("resolved", 0)
    print("-" * 92)
    print(f"{ok}/{total} shots resolved exactly "
          f"({ok/total*100:.0f}%)" if total else "nothing to resolve")
    for k in ("ambiguous", "weak", "not_found", "no_query"):
        if counts.get(k):
            print(f"  {icon[k].strip()} {k:<10} {counts[k]}")
    if a.out:
        payload = [{"beat": r.beat, "shot": r.shot, "status": r.status,
                    "query": r.query, "note": r.note,
                    "hit": r.hit.as_dict() if r.hit else None,
                    "others": [h.as_dict() for h in r.others]} for r in rows]
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(f"\nwrote {a.out}")
    return 0 if counts.get("not_found", 0) == 0 else 1


def cmd_sync(a):
    """Check one file's subtitles against its audio."""
    kind, sub_path, cues = subtitles.load_for_video(a.video)
    if not cues:
        print("no subtitles found for this file")
        return 1
    print(f"{len(cues)} cues from {kind}"
          + (f" ({os.path.basename(sub_path)})" if sub_path else ""))
    r = sync.detect(a.video, cues, try_framerates=not a.no_framerate,
                    max_seconds=a.seconds,
                    log=(lambda m: print(m)) if a.verbose else (lambda *x: None))
    print(f"\n  {r.describe()}")
    if r.confidence == "low":
        print("  → these subtitles may belong to a different release")
        return 1
    if not r.in_sync:
        print(f"  → apply {r.offset_ms:+d} ms"
              + (f" and scale {r.scale:.5f} ({r.scale_name})" if r.scale != 1 else ""))
    return 0


def cmd_cut(a):
    """Find a line and write the clip in one step."""
    hits = search.find(a.db, a.quote, show=a.show, season=a.season,
                       episode=a.episode, limit=1)
    if not hits:
        print("no match — nothing cut")
        return 1
    h = hits[0]
    print(f"{h.label}  {h.timecode}  [{h.confidence}]")
    print(f'  "{h.matched_text}"')
    if h.confidence == "low" and not a.force:
        print("  refusing to cut a low-confidence match (use --force)")
        return 1

    if a.window:
        # Measurement mode. A 5-second clip can only answer yes or no, and
        # when the answer is no it does not say by how much — which is the
        # one number needed to fix anything. A window puts the claimed
        # position in the middle and lets the ear read the error off it.
        half = a.window / 2.0
        start = max(0.0, h.start_ms / 1000.0 - half)
        mark = h.start_ms / 1000.0 - start
        cutter.cut_clip(h.path, start, start + a.window, a.out,
                        mode=a.mode, height=a.height, with_audio=True)
        print(f"  wrote {a.out}  ({a.window:.0f}s window)")
        print()
        print(f"  The tool thinks this line is at {int(mark // 60)}:"
              f"{mark % 60:04.1f} into this clip.")
        print("  Play it. If you hear the line somewhere else, note that")
        print("  time — the difference is exactly how far out this episode is.")
        return 0

    cut = cutter.clip_for_hit(h, a.out, target_seconds=a.seconds,
                              mode=a.mode, height=a.height,
                              cover_full_line=a.full_line,
                              with_audio=a.audio, log=print)
    print(f"  wrote {a.out}  ({cut.duration:.2f}s)")
    if a.still:
        mid = (cut.start + cut.end) / 2
        cutter.extract_frame(h.path, mid, a.still, width=a.still_width)
        print(f"  wrote {a.still}")
    return 0


def cmd_sources(a):
    """Which titles does this script need, and are they in the library?"""
    with open(a.script, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    beats = data if isinstance(data, list) else data.get("beats", [])
    reqs = sources.check(a.db, beats, resolve_dialogue=not a.fast)
    print(sources.format_report(reqs))
    if a.out:
        payload = [{"title": r.title, "shots": r.shots, "status": r.status,
                    "note": r.note, "beats": r.beats,
                    "library_titles": r.library_titles,
                    "episodes_needed": sorted(
                        f"S{s:02d}E{e:02d}" for s, e in
                        (r.episodes_declared | r.episodes_resolved) if e),
                    "episodes_missing": sorted(
                        f"S{s:02d}E{e:02d}" for s, e in r.missing_episodes if e)}
                   for r in reqs]
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(f"\nwrote {a.out}")
    return 1 if any(r.status == "missing" for r in reqs) else 0


def cmd_align(a):
    """Place shots that carry no dialogue, by walking the scene in order."""
    with open(a.script, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    beats = data if isinstance(data, list) else data.get("beats", [])
    places = align.align(a.db, beats, log=print)
    print()
    print(f"{'beat':>5} {'method':<14} {'time':>13} {'conf':<8} note")
    print("-" * 92)
    for p in places:
        print(f"{p.beat:>5}.{p.shot} {p.method:<13} "
              f"{(p.timecode if p.ok else '-'):>13} {p.confidence:<8} {p.note}")
    print("-" * 92)
    print(align.summarise(places))
    return 0


def cmd_subs(a):
    """Attach a downloaded subtitle pack to the right videos."""
    matches = subs.link(a.media_dir, a.subs, verify=not a.no_verify,
                        overwrite=a.overwrite, log=print)
    print(subs.format_results(matches))
    return 1 if any(m.status == "none" for m in matches) else 0


def cmd_stills(a):
    """Pull many distinct, good-quality stills out of a file or a range."""
    cands = frames.scan(a.video, a.start, a.end)
    best = frames.pick(cands, a.count)
    print(f"  {frames.describe(cands, best)}")
    out = a.out or os.path.join(os.path.dirname(a.video) or ".", "stills")
    written = frames.extract_stills(a.video, out, a.count, a.start, a.end,
                                    width=a.width, log=print)
    print(f"  wrote {len(written)} image(s) to {out}")
    return 0 if written else 1


def cmd_look(a):
    """Index what the footage LOOKS like, so shots can be checked, not guessed.

    Slow and one-time, exactly like building the dialogue index — and for the
    same reason. Every script written about these episodes afterwards asks
    this index questions for free.
    """
    ok, why = embed.available()
    if not ok:
        print(f"  The picture model is not installed — {why}")
        print("\n  Install it with:")
        print("      pip install torch transformers sentencepiece")
        print(f"\n  The first run then downloads ~1 GB into {embed.models_dir()}")
        print("  After that it works with no internet at all.")
        return 1

    only = None
    if a.script:
        if not os.path.isfile(a.script):
            print(f"  No such script: {a.script}")
            return 1
        with open(a.script, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        beats = data if isinstance(data, list) else (data.get("beats") or [])
        only = visual.files_for_script(a.db, beats)
        if not only:
            print("  That script names no episode that is in the library.")
            return 1
        print(f"  this script needs {len(only)} file(s):")
        for path in only[:20]:
            print(f"      {os.path.basename(path)}")

    done, total = visual.coverage(a.db)
    print(f"  {done} of {total} file(s) already have their pictures indexed")
    if only is None and done >= total and total and not a.force:
        print("  nothing to do — add --force to redo them")
        return 0

    res = visual.build(a.db, only=only, fps=a.fps, force=a.force, log=print)
    print("")
    print(f"  looked at {res.indexed} file(s) {term.sym('dot')} "
          f"skipped {res.skipped} {term.sym('dot')} "
          f"{res.frames:,} frames in {res.seconds / 60:.0f} min")
    if res.failed:
        print(f"\n  {len(res.failed)} file(s) could not be read:")
        for path, why in res.failed[:20]:
            print(f"      {os.path.basename(path)}  —  {why}")
    done, total = visual.coverage(a.db)
    print(f"\n  {done} of {total} file(s) can now be checked by picture")
    return 0 if not res.failed else 1


def cmd_check(a):
    """Inspect a media folder and say whether it will work."""
    reports = doctor.inspect_folder(
        a.media_dir, log=(lambda m: print(m)) if a.verbose else (lambda *x: None))
    print(doctor.format_report(reports, a.media_dir))
    bad = [r for r in reports if r.verdict != doctor.VERDICT_OK]
    return 1 if bad else 0


def cmd_transcribe(a):
    """Make subtitles from the audio when a file has none."""
    if not transcribe.available():
        print("faster-whisper is not installed.\n"
              "  Install it with:  pip install faster-whisper\n"
              "  The first run then downloads the model (a few hundred MB).")
        return 1
    target = a.target
    try:
        if os.path.isdir(target):
            results = transcribe.transcribe_folder(
                target, model_name=a.model, overwrite=a.overwrite)
        else:
            results = [transcribe.transcribe_file(
                target, model_name=a.model, overwrite=a.overwrite, log=print)]
    except transcribe.TranscribeUnavailable as exc:
        print(f"\n  {exc}")
        return 1
    print(transcribe.format_results(results))
    return 1 if any(r.status == "failed" for r in results) else 0


def cmd_preflight(a):
    """Check every queued job without building anything."""
    queue = jobs_mod.load_jobs(a.jobs)
    reports = jobs_mod.preflight_all(queue, log=lambda m: print("  " + str(m)))
    print(jobs_mod.format_reports(reports))
    return 1 if any(r.status == "BLOCKED" for r in reports) else 0


def cmd_make(a):
    """Build one video from one script, without writing a job file.

    The queue exists for twenty-five videos overnight. Testing a single
    script should not require authoring JSON about JSON first.
    """
    job = jobs_mod.Job(name=a.name or os.path.splitext(
        os.path.basename(a.script))[0],
        script=os.path.abspath(a.script),
        out=os.path.abspath(a.out), db=os.path.abspath(a.db),
        clip_seconds=a.seconds, height=a.height,
        stills_per_scene=a.stills)
    report = jobs_mod.preflight(job, log=lambda m: print("  " + str(m)))
    print(jobs_mod.format_reports([report]))
    # Printed in full only here. The queue builds twenty-five videos and this
    # would bury its summary; a single script is being tested, and the whole
    # point of testing one is to find out what to change in it.
    if report.quotes and report.quotes.advice():
        print("\n  ABOUT THE QUOTED LINES")
        print(f"  {report.quotes.detail()}\n")
        for line in report.quotes.advice():
            print(f"      {line}")
    if report.blocked and not a.force:
        print("\n  blocked — nothing built (use --force to try anyway)")
        return 1
    result = runner.run_job(job, report, log=print)
    print(f"\n  {result.clips} clip(s), {result.stills} still(s) "
          f"in {result.seconds:.0f}s")
    print(f"  {result.gaps} scene(s) with nothing")
    print(f"  -> {job.out}")
    return 0


def cmd_sheet(a):
    """One page of every still, so a hundred can be judged at a glance."""
    made = contact.build(a.folder, a.out, columns=a.columns, log=print)
    if not made:
        print("  no images found under " + a.folder)
        return 1
    print(f"  wrote {made}")
    return 0


def cmd_run(a):
    if os.path.isdir(a.jobs):
        print(f"  {a.jobs} is a folder.\n"
              "  This step wants a job FILE (jobs.json) listing the videos to\n"
              "  build. To point the tool at a folder of episodes, use "
              "'Set the media folder'.")
        return 1
    if not os.path.isfile(a.jobs):
        print(f"  No such job file: {a.jobs}")
        return 1
    """Pre-flight the whole queue, then build what passed."""
    results = runner.run_queue(a.jobs, dry_run=a.dry_run,
                               allow_gaps=not a.strict)
    return 1 if any(r.status in ("failed", "skipped") for r in results) else 0


def main(argv=None):
    term.enable_utf8()          # never let a code page raise
    # --db is shared by every subcommand, and works on either side of it
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default="library.db",
                        help="index file (default library.db)")

    p = argparse.ArgumentParser(prog="media_index", parents=[common],
                                description="Dialogue index for owned media.")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", parents=[common],
                       help="scan a media folder into the index")
    b.add_argument("media_dir")
    b.add_argument("--verify-sync", action="store_true",
                   help="check every subtitle against the audio and correct drift")
    b.add_argument("--sync-seconds", type=float,
                   help="only analyse the first N seconds when checking sync")
    b.set_defaults(func=cmd_build)

    s = sub.add_parser("stats", parents=[common], help="what is in the index")
    s.set_defaults(func=cmd_stats)

    f = sub.add_parser("find", parents=[common], help="locate a spoken line")
    f.add_argument("quote")
    f.add_argument("--show")
    f.add_argument("--season", type=int)
    f.add_argument("--episode", type=int)
    f.add_argument("--limit", type=int, default=5)
    f.set_defaults(func=cmd_find)

    r = sub.add_parser("resolve", parents=[common], help="pre-flight a whole visual script")
    r.add_argument("script", help="JSON from the visual-script prompt")
    r.add_argument("--out", help="write the full report as JSON")
    r.set_defaults(func=cmd_resolve)

    y = sub.add_parser("sync", parents=[common],
                       help="check one file's subtitle timing against its audio")
    y.add_argument("video")
    y.add_argument("--seconds", type=float, help="analyse only the first N seconds")
    y.add_argument("--no-framerate", action="store_true",
                   help="skip the framerate-conversion search")
    y.add_argument("-v", "--verbose", action="store_true")
    y.set_defaults(func=cmd_sync)

    c = sub.add_parser("cut", parents=[common],
                       help="find a line and write the clip")
    c.add_argument("quote")
    c.add_argument("--out", required=True, help="output clip path")
    c.add_argument("--seconds", type=float, default=4.0, help="clip length")
    c.add_argument("--full-line", action="store_true",
                   help="cover the whole spoken line instead of --seconds")
    c.add_argument("--mode", choices=("accurate", "fast"), default="accurate")
    c.add_argument("--height", type=int, help="scale output to this height")
    c.add_argument("--window", type=float, default=0.0,
                   help="cut this many seconds AROUND the line instead of a "
                        "clip, to measure how far out the subtitles are")
    c.add_argument("--audio", action="store_true",
                   help="keep the original sound (use when you will watch it)")
    c.add_argument("--still", help="also write a still frame here")
    c.add_argument("--still-width", type=int, default=1920)
    c.add_argument("--show")
    c.add_argument("--season", type=int)
    c.add_argument("--episode", type=int)
    c.add_argument("--force", action="store_true",
                   help="cut even a low-confidence match")
    c.set_defaults(func=cmd_cut)

    o = sub.add_parser("sources", parents=[common],
                       help="what titles this script needs, and what is missing")
    o.add_argument("script", help="JSON from the visual-script prompt")
    o.add_argument("--out", help="write the report as JSON")
    o.add_argument("--fast", action="store_true",
                   help="skip dialogue resolution (titles only, no episodes)")
    o.set_defaults(func=cmd_sources)

    u = sub.add_parser("subs", parents=[common],
                       help="attach a downloaded subtitle pack to the videos")
    u.add_argument("media_dir")
    u.add_argument("--subs", help="folder holding the .srt files "
                                  "(default: the media folder itself)")
    u.add_argument("--no-verify", action="store_true",
                   help="skip playing each version against the audio")
    u.add_argument("--overwrite", action="store_true")
    u.set_defaults(func=cmd_subs)

    i = sub.add_parser("stills", parents=[common],
                       help="pull many distinct stills out of a video")
    i.add_argument("video")
    i.add_argument("--count", type=int, default=20)
    i.add_argument("--start", type=float, default=0.0)
    i.add_argument("--end", type=float)
    i.add_argument("--width", type=int, default=1920)
    i.add_argument("--out", help="output folder (default <video folder>/stills)")
    i.set_defaults(func=cmd_stills)

    g = sub.add_parser("align", parents=[common],
                       help="place shots that have no dialogue, along the scene")
    g.add_argument("script", help="JSON from the visual-script prompt")
    g.set_defaults(func=cmd_align)

    d = sub.add_parser("check", parents=[common],
                       help="inspect a media folder before indexing it")
    d.add_argument("media_dir")
    d.add_argument("-v", "--verbose", action="store_true")
    d.set_defaults(func=cmd_check)

    t = sub.add_parser("transcribe", parents=[common],
                       help="make subtitles from the audio (files with none)")
    t.add_argument("target", help="a video file, or a folder of them")
    t.add_argument("--model", default=transcribe.DEFAULT_MODEL,
                   help=f"whisper model (default {transcribe.DEFAULT_MODEL}; "
                        "small.en is slower and more accurate)")
    t.add_argument("--overwrite", action="store_true",
                   help="redo files that already have a subtitle")
    t.set_defaults(func=cmd_transcribe)

    mk = sub.add_parser("make", parents=[common],
                       help="build one video from one script")
    mk.add_argument("script")
    mk.add_argument("--out", required=True, help="output folder")
    mk.add_argument("--name", default="")
    mk.add_argument("--seconds", type=float, default=4.0)
    mk.add_argument("--stills", type=int, default=2,
                    help="stills to take per shot")
    mk.add_argument("--height", type=int)
    mk.add_argument("--force", action="store_true")
    mk.set_defaults(func=cmd_make)

    sh = sub.add_parser("sheet", parents=[common],
                        help="contact sheet of every still that was made")
    sh.add_argument("folder", help="a job output folder")
    sh.add_argument("--out", default="contact_sheet.jpg")
    sh.add_argument("--columns", type=int, default=8)
    sh.set_defaults(func=cmd_sheet)

    lk = sub.add_parser("look", parents=[common],
                        help="index what the footage looks like (slow, once)")
    lk.add_argument("--fps", type=float, default=visual.DEFAULT_FPS,
                    help=f"frames sampled per second (default {visual.DEFAULT_FPS})")
    lk.add_argument("--script",
                    help="index only the episodes this visual script needs")
    lk.add_argument("--force", action="store_true",
                    help="redo files that are already done")
    lk.set_defaults(func=cmd_look)

    q = sub.add_parser("preflight", parents=[common],
                       help="check a queue of jobs without building anything")
    q.add_argument("jobs", help="job file (JSON)")
    q.set_defaults(func=cmd_preflight)

    n = sub.add_parser("run", parents=[common],
                       help="pre-flight a queue, then build every job that passed")
    n.add_argument("jobs", help="job file (JSON)")
    n.add_argument("--dry-run", action="store_true",
                   help="pre-flight only, build nothing")
    n.add_argument("--strict", action="store_true",
                   help="build only jobs with no gaps at all")
    n.set_defaults(func=cmd_run)

    a = p.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
