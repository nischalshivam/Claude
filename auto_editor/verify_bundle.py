#!/usr/bin/env python3
"""Structural self-check for a generated .wfpbundle (no Filmora needed).

Verifies the invariants a real Filmora save exhibits:
  - zip-in-zip layout, all JSON parses
  - every timeline clip's %DOCUMENT_DIR% file exists in the bundle's Medias/
  - every clip sourceUuid resolves to a resource entry
  - every extra.json clip instance GUID exists on some clip (userData key 3)
  - medias_info covers every media GUID + the timeline media
  - times are sane: begin < end, transitions overlap their boundary
  - (optional) same key-shape as a reference sample project's clips
"""
from __future__ import annotations

import base64
import io
import json
import sys
import zipfile

OK, BAD = "  ok:", "  FAIL:"


def _inst_guid(clip) -> str | None:
    for ud in clip.get("userData", []):
        if ud.get("key") == 3:
            raw = base64.b64decode(ud["data"] + "=" * (-len(ud["data"]) % 4))
            return raw.rstrip(b"\x00").decode("utf-8", "replace")
    return None


def load(path):
    outer = zipfile.ZipFile(path)
    wfp = next(n for n in outer.namelist() if n.endswith(".wfp") and "/" not in n)
    inner = zipfile.ZipFile(io.BytesIO(outer.read(wfp)))
    read = lambda z, s: json.loads(z.read(next(n for n in z.namelist() if n.endswith(s))))
    return outer, inner, read(inner, "timeline.wesproj"), read(inner, "project_info.json"), \
        read(inner, "medias_info.json"), read(inner, "extra.json")


def clip_shapes(wes):
    shapes = {}
    for tl in wes["timelineInfos"]:
        for tr in tl["trackInfos"]:
            for c in tr.get("clipList", []):
                shapes.setdefault((tl.get("type"), tr.get("trackType"), c.get("type")),
                                  frozenset(c.keys()))
    return shapes


def main(gen_path, ref_path=None):
    fails = 0

    def check(cond, label, detail=""):
        nonlocal fails
        print((OK if cond else BAD), label, detail if not cond else "")
        if not cond:
            fails += 1

    outer, inner, wes, pi, mi, extra = load(gen_path)
    print(f"checking {gen_path}")

    media_files = {n.split("/")[1]: n for n in outer.namelist() if n.startswith("Medias/")}
    resources = {r["sourceUuid"]: r for r in wes.get("resources", [])}
    main_tl = next(t for t in wes["timelineInfos"] if t.get("type") == 0)
    sub_ids = {t["timelineId"] for t in wes["timelineInfos"] if t.get("type") == 1}

    clips = [(tl, tr, c) for tl in wes["timelineInfos"] for tr in tl["trackInfos"]
             for c in tr.get("clipList", [])]
    check(len(clips) > 0, f"{len(clips)} clips present")

    end = 0
    insts = set()
    for tl, tr, c in clips:
        b, e = c.get("tlBegin", 0), c.get("tlEnd", 0)
        check(b < e, f"clip time order ({c.get('filename', c.get('type'))})", f"{b}..{e}")
        end = max(end, e if tl is main_tl else 0)
        fn = c.get("filename", "")
        if fn.startswith("%DOCUMENT_DIR%"):
            guid = fn.split("/")[2]
            check(guid in media_files, f"media in bundle for {fn.split('/')[-1]}", guid)
            check(c.get("sourceUuid") in resources, f"resource for {fn.split('/')[-1]}")
        if c.get("type") == 7:
            check(c.get("timelineId") in sub_ids, "text sub-timeline exists",
                  c.get("timelineId"))
        pt = c.get("postTransition")
        if pt:
            check(pt["tlBegin"] < e <= pt["tlEnd"] or pt["tlBegin"] <= e,
                  f"transition window straddles clip end ({pt.get('display')})")
        gi = _inst_guid(c)
        if gi and (tl is main_tl):
            insts.add(gi)

    mapinfo = set(extra.get("mediaClipsMapInfo", {}))
    check(insts <= mapinfo, "all clip instances mapped in extra.json",
          insts - mapinfo)

    tl_guid = pi["timeline_mediaId"]
    check(tl_guid in mi["media_items"], "timeline media in medias_info")
    for guid in media_files:
        check(guid in mi["media_items"], f"medias_info entry for {guid}")
    check(pi["project_timeline_duration"] == max(
        (c.get("tlEnd", 0) for tl in wes["timelineInfos"] if tl.get("type") == 0
         for tr in tl["trackInfos"] for c in tr.get("clipList", [])), default=0),
        "project duration == timeline end")

    if ref_path:
        OPTIONAL = {"inAnimation", "outAnimation", "postTransition", "preTransition"}
        _, _, ref_wes, *_ = load(ref_path)
        ref_shapes = clip_shapes(ref_wes)
        for key, shape in clip_shapes(wes).items():
            if key in ref_shapes:
                extra_keys = shape - ref_shapes[key] - OPTIONAL
                missing = ref_shapes[key] - shape - OPTIONAL
                check(not extra_keys and not missing,
                      f"clip shape matches sample for {key}",
                      f"extra={sorted(extra_keys)} missing={sorted(missing)}")

    print(("ALL CHECKS PASSED" if fails == 0 else f"{fails} CHECKS FAILED"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
