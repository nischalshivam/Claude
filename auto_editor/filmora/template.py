"""Load a Filmora .wfpbundle / .wfp and extract everything the builder needs.

The golden rule of this tool: NEVER invent Filmora structures. Every clip,
transition, animation, effect chain and text block we write is a deep copy of
a prototype harvested from a real project saved by the user's own Filmora
installation. That guarantees every effect is supported by their version.

A "template" is a dict with:
  wesproj        : the sample timeline.wesproj (dict)
  project_info   : sample project_info.json
  extra_json     : sample extra.json (timeline media folder)
  media_jsons    : {"video": ..., "image": ..., "audio": ...} sample media.json
  function_extra : Anon/AppData/Windows/functionExtraData.json content (str)
"""
from __future__ import annotations

import copy
import io
import json
import zipfile
from dataclasses import dataclass, field


def _read_bundle(path: str) -> dict:
    """Extract template parts from a .wfpbundle (zip with inner .wfp zip) or .wfp."""
    with open(path, "rb") as f:
        outer = zipfile.ZipFile(io.BytesIO(f.read()))
    wfp_names = [n for n in outer.namelist() if n.lower().endswith(".wfp") and "/" not in n]
    if wfp_names:  # .wfpbundle: Medias/... + Name.wfp
        inner = zipfile.ZipFile(io.BytesIO(outer.read(wfp_names[0])))
    else:  # plain .wfp given directly
        inner = outer

    names = inner.namelist()

    def read_json(suffix):
        for n in names:
            if n.endswith(suffix):
                return json.loads(inner.read(n).decode("utf-8"))
        raise FileNotFoundError(f"{suffix} not found inside {path}")

    wesproj = read_json("timeline.wesproj")
    project_info = read_json("project_info.json")
    extra_json = read_json("extra.json")

    # sample media.json per stream type
    media_jsons = {}
    for n in names:
        if n.endswith("/media.json"):
            mj = json.loads(inner.read(n).decode("utf-8"))
            st = mj.get("sourceInfo", {}).get("basicInfo", {}).get("streamType")
            kind = {2: "video", 5: "image", 3: "audio"}.get(st)
            if kind and kind not in media_jsons:
                media_jsons[kind] = mj

    function_extra = "{\"9\":\"4\"}"
    for n in names:
        if n.endswith("functionExtraData.json"):
            function_extra = inner.read(n).decode("utf-8")

    # Small binary blobs Filmora writes into every project; carried verbatim.
    import base64 as _b64
    binaries = {}
    tl_guid = project_info.get("timeline_mediaId", "")
    for n in names:
        if tl_guid and n.endswith(f"{tl_guid}/thumbnail.png"):
            binaries["tl_thumbnail_png"] = _b64.b64encode(inner.read(n)).decode()
        elif n.endswith("Anon/Cover/thumb.fsthumb"):
            binaries["cover_fsthumb"] = _b64.b64encode(inner.read(n)).decode()

    return {
        "wesproj": wesproj,
        "project_info": project_info,
        "extra_json": extra_json,
        "media_jsons": media_jsons,
        "function_extra": function_extra,
        "binaries": binaries,
    }


@dataclass
class Template:
    raw: dict
    # prototypes (deep-copied on use)
    image_clip: dict = None
    video_clip: dict = None
    narration_clip: dict = None
    clip_audio: dict = None           # paired audio of a video clip (tag-1 track)
    clip_audio_track_idx: int = -1
    text_clip: dict = None            # the type-7 clip that sits on the text track
    text_subtimeline: dict = None     # the sub-timeline holding the actual title
    transitions: dict = field(default_factory=dict)  # lower name -> postTransition proto
    animations: dict = field(default_factory=dict)   # lower name -> inAnimation proto
    resources: dict = field(default_factory=dict)    # kind -> resource entry proto
    # track template info
    track_protos: list = None         # trackInfos with clipList emptied
    video_track_idx: int = -1
    text_track_idx: int = -1
    narration_track_idx: int = -1
    main_timeline_userdata_name: str = ""

    @property
    def wesproj(self):
        return self.raw["wesproj"]

    @property
    def project_info(self):
        return self.raw["project_info"]

    @property
    def extra_json(self):
        return self.raw["extra_json"]

    @property
    def media_jsons(self):
        return self.raw["media_jsons"]

    @property
    def function_extra(self):
        return self.raw["function_extra"]

    @property
    def binaries(self):
        return self.raw.get("binaries", {})


def _anim_name(clip: dict) -> str | None:
    """Animation display name lives in userData key 13011 (e.g. 'Zoom out 2')."""
    from .ids import userdata_get_raw
    raw = userdata_get_raw(clip.get("userData", []), 13011)
    if raw:
        return raw.rstrip(b"\x00").decode("utf-8", "replace")
    return None


def load_template(path: str) -> Template:
    """path may be a .wfpbundle/.wfp or a pre-extracted template .json."""
    if path.lower().endswith(".json"):
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    else:
        raw = _read_bundle(path)
    t = Template(raw=raw)
    _index(t)
    return t


def save_template_json(t: Template, out_path: str) -> None:
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(t.raw, f, ensure_ascii=False)


def _index(t: Template) -> None:
    wes = t.wesproj
    main_tl = next(tl for tl in wes["timelineInfos"] if tl.get("type") == 0)
    sub_tls = {tl["timelineId"]: tl for tl in wes["timelineInfos"] if tl.get("type") == 1}

    for i, tr in enumerate(main_tl["trackInfos"]):
        clips = tr.get("clipList", [])
        if tr.get("trackType") == 1:
            if any(c.get("type") == 7 for c in clips):
                t.text_track_idx = i
                for c in clips:
                    if c.get("type") == 7 and t.text_clip is None:
                        t.text_clip = copy.deepcopy(c)
                        sub = sub_tls.get(c.get("timelineId"))
                        if sub:
                            t.text_subtimeline = copy.deepcopy(sub)
            elif any(c.get("type") == 1 for c in clips):
                t.video_track_idx = i
                from .probe import kind_of
                for c in clips:
                    kind = kind_of(c.get("filename", ""))
                    if kind == "image" and t.image_clip is None:
                        t.image_clip = copy.deepcopy(c)
                    if kind == "video" and t.video_clip is None:
                        t.video_clip = copy.deepcopy(c)
        elif tr.get("trackType") == 2 and clips:
            from .probe import kind_of
            for c in clips:
                kind = kind_of(c.get("filename", ""))
                if kind == "audio" and t.narration_clip is None:
                    t.narration_track_idx = i
                    t.narration_clip = copy.deepcopy(c)
                elif kind == "video" and t.clip_audio is None:
                    t.clip_audio_track_idx = i
                    t.clip_audio = copy.deepcopy(c)

    if t.video_track_idx < 0:
        raise ValueError("Template has no video track with media clips — "
                         "the sample project must contain at least one clip/image.")

    # Harvest every transition and animation used anywhere in the sample.
    for tl in wes["timelineInfos"]:
        for tr in tl["trackInfos"]:
            for c in tr.get("clipList", []):
                pt = c.get("postTransition")
                if pt and pt.get("display"):
                    t.transitions.setdefault(pt["display"].lower(), copy.deepcopy(pt))
                ia = c.get("inAnimation")
                if ia:
                    name = _anim_name(c)
                    if name:
                        from .ids import userdata_get_raw
                        blob = userdata_get_raw(c.get("userData", []), 30316)
                        t.animations.setdefault(name.lower(), {
                            "inAnimation": copy.deepcopy(ia),
                            "name": name,
                            "ud30316": blob.decode("utf-8", "replace").rstrip("\x00")
                                       if blob else None,
                        })

    # Resource prototypes by kind (streamType: 2 video, 5 image, 3 audio).
    for res in wes.get("resources", []):
        st = res.get("streamType")
        kind = {2: "video", 5: "image", 3: "audio"}.get(st)
        if kind and kind not in t.resources:
            t.resources[kind] = copy.deepcopy(res)

    # Track prototypes with clips removed (keeps bus routing / userData intact).
    t.track_protos = []
    for tr in main_tl["trackInfos"]:
        proto = copy.deepcopy(tr)
        proto["clipList"] = []
        t.track_protos.append(proto)


if __name__ == "__main__":
    import sys
    t = load_template(sys.argv[1])
    save_template_json(t, sys.argv[2])
    print("transitions:", sorted(t.transitions))
    print("animations:", sorted(t.animations))
    print("protos: image=%s video=%s narration=%s text=%s" % (
        t.image_clip is not None, t.video_clip is not None,
        t.narration_clip is not None, t.text_clip is not None))
    print("saved template ->", sys.argv[2])
