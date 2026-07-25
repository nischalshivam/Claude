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

from . import library, search


def _fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} GB"


def cmd_build(a):
    res = library.build(a.media_dir, a.db)
    print("")
    print(f"  added {res.added} · updated {res.updated} · skipped {res.skipped}")
    print(f"  {res.cues:,} dialogue lines indexed in {res.seconds:.1f}s")
    if res.no_subs:
        print(f"\n  ⚠ {len(res.no_subs)} file(s) with no usable subtitles:")
        for p, why in res.no_subs[:20]:
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
        mark = {"high": "✓", "medium": "~", "low": "?"}[h.confidence]
        a0, b0 = h.cut_window()
        print(f"{mark} {i}. {h.label}   {h.timecode}   "
              f"score {h.score:.0f}  cov {h.coverage:.0%}  [{h.confidence}]")
        print(f'      "{h.matched_text}"')
        print(f"      cut {a0/1000:.1f}s → {b0/1000:.1f}s   {os.path.basename(h.path)}")
    return 0


def cmd_resolve(a):
    with open(a.script, "r", encoding="utf-8") as f:
        data = json.load(f)
    beats = data if isinstance(data, list) else data.get("beats", [])
    rows = search.resolve_script(a.db, beats)

    icon = {"resolved": "✅", "ambiguous": "⚠️ ", "weak": "⚠️ ",
            "not_found": "❌", "no_query": "◻️ "}
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


def main(argv=None):
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

    a = p.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
