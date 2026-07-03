"""Build a Filmora timeline.wesproj (+ sidecar JSONs) from a scene plan.

Everything structural is deep-copied from the Template prototypes; we only
change times, file references, ids and text. See HANDOFF docs for the schema.
"""
from __future__ import annotations

import copy
import json
import os
import time
from dataclasses import dataclass, field

from .ids import guid_upper, uuid_lower, b64_str, userdata_set
from .probe import MediaInfo, probe

TICKS = 10_000_000
IMAGE_INPOINT_BASE = 3600 * TICKS  # Filmora anchors still images at t=3600s in source time


# ----------------------------------------------------------------------------
# Plan model (produced by the scene planner, consumed here)
# ----------------------------------------------------------------------------

@dataclass
class PlanItem:
    path: str                    # absolute path on the user's machine
    kind: str                    # "video" | "image"
    tl_begin: int = 0            # ticks on the timeline
    tl_end: int = 0
    in_point: int = 0            # source in-point (videos only), ticks
    animation: str | None = None # template animation name (e.g. "zoom out 2")
    transition: str | None = None  # template transition after this item
    display_name: str = ""
    scene_index: int = 0

    @property
    def duration(self) -> int:
        return self.tl_end - self.tl_begin


@dataclass
class TextItem:
    text: str
    tl_begin: int = 0
    tl_end: int = 0
    scene_index: int = 0


@dataclass
class Plan:
    items: list = field(default_factory=list)   # [PlanItem]
    texts: list = field(default_factory=list)   # [TextItem]
    narration_audio: str | None = None
    project_name: str = "AutoEdit"

    @property
    def duration(self) -> int:
        ends = [i.tl_end for i in self.items]
        if self.narration_audio and getattr(self, "narration_ticks", 0):
            ends.append(self.narration_ticks)
        return max(ends) if ends else 0


# ----------------------------------------------------------------------------
# Media registry: one entry per unique file
# ----------------------------------------------------------------------------

@dataclass
class MediaEntry:
    path: str
    kind: str
    guid: str
    source_uuid: str
    info: MediaInfo
    name: str  # basename without extension
    md5: str = ""
    original_path: str = ""  # path written into the project JSONs (Windows form)

    @property
    def basename(self) -> str:
        return os.path.basename(self.path)

    @property
    def doc_filename(self) -> str:
        return f"%DOCUMENT_DIR%/Medias/{self.guid}/{self.basename}"


def _file_md5(path: str) -> str:
    import hashlib
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Registry:
    def __init__(self, path_map: dict | None = None):
        self.by_path: dict[str, MediaEntry] = {}
        # optional {abs local path -> path to write into the project JSONs};
        # lets tests generated on Linux carry valid Windows paths
        self.path_map = {os.path.abspath(k): v for k, v in (path_map or {}).items()}

    def get(self, path: str) -> MediaEntry:
        key = os.path.abspath(path)
        if key not in self.by_path:
            info = probe(key)
            self.by_path[key] = MediaEntry(
                path=key, kind=info.kind, guid=guid_upper(),
                source_uuid=uuid_lower(), info=info,
                name=os.path.splitext(os.path.basename(key))[0],
                md5=_file_md5(key),
                original_path=self.path_map.get(key, _win_path(key)))
        return self.by_path[key]

    @property
    def entries(self):
        return list(self.by_path.values())


# ----------------------------------------------------------------------------
# Field patching helpers
# ----------------------------------------------------------------------------

def _win_path(path: str) -> str:
    return os.path.abspath(path).replace("\\", "/")


def _patch_stream_lists(container: dict, e: MediaEntry) -> None:
    """Patch vid/aud stream info lists inside a resource entry or media.json
    sourceInfo (key spellings differ: vidStreamInfo vs vidStreamInfos).
    IMPORTANT: only update keys the prototype already has — never add new
    keys, Filmora's deserializer may reject unknown fields."""
    info = e.info

    def setk(d, key, value):
        if key in d:
            d[key] = value

    dur = info.duration_ticks
    for key in ("vidStreamInfo", "vidStreamInfos"):
        for s in container.get(key) or []:
            setk(s, "width", info.width or s.get("width", 1920))
            setk(s, "height", info.height or s.get("height", 1080))
            setk(s, "xRatio", info.width or s.get("xRatio", 1920))
            setk(s, "yRatio", info.height or s.get("yRatio", 1080))
            if e.kind == "video":
                setk(s, "streamLength", dur)
                setk(s, "frameRate", {"num": info.fps_num, "den": info.fps_den})
                setk(s, "lastframeRate", {"num": info.fps_num, "den": info.fps_den})
                setk(s, "maxFrameRate", {"num": info.fps_num * 1000, "den": info.fps_den * 1000})
                setk(s, "totalFrames", info.total_frames)
                setk(s, "maxGopSize", info.total_frames)
                if info.bit_rate:
                    setk(s, "bitRate", info.bit_rate)
    for key in ("audStreamInfo", "audStreamInfos"):
        for s in container.get(key) or []:
            setk(s, "streamLength", dur)
            setk(s, "sampleRate", info.sample_rate)
            setk(s, "channels", info.channels)
            setk(s, "duration", round(dur / TICKS, 8))
            setk(s, "bitRate", info.audio_bit_rate)


def _patch_basic(basic: dict, e: MediaEntry, now: int) -> None:
    info = e.info
    if e.kind != "image":
        basic["mediaLength"] = info.duration_ticks
        if info.bit_rate:
            basic["bitRate"] = info.bit_rate
    basic["createDate"] = now
    if "modifyDate" in basic:
        basic["modifyDate"] = now
    if e.kind == "video":
        basic["audioStreamCount"] = 1 if info.has_audio else 0


def _retime_keyframes(param_json: str, scale: float) -> str:
    """Scale keyframe _time values (parameter blobs are JSON-in-a-string)."""
    try:
        p = json.loads(param_json)
        for kf in p.get("keyframeSets", []):
            kf["_time"] = round(kf["_time"] * scale, 6)
        return json.dumps(p)
    except Exception:
        return param_json


def _retime_animation(anim: dict, item_ticks: int) -> dict:
    """If the template animation is longer than the clip, compress it to fit."""
    anim = copy.deepcopy(anim)
    a_dur = anim.get("duration", 0)
    if a_dur and a_dur > item_ticks and item_ticks > 0:
        scale = item_ticks / a_dur
        anim["duration"] = item_ticks
        for eff in anim.get("effectChain", {}).get("effectList", []):
            for pm in eff.get("paramMapList", []):
                kf = pm.get("keyFrame", {})
                if isinstance(kf.get("parameter"), str):
                    kf["parameter"] = _retime_keyframes(kf["parameter"], scale)
    return anim


# ----------------------------------------------------------------------------
# The builder
# ----------------------------------------------------------------------------

class BuildResult:
    def __init__(self):
        self.wesproj = None
        self.project_info = None
        self.medias_info = None
        self.extra_json = None
        self.media_entries = []      # [MediaEntry]
        self.timeline_media_guid = ""
        self.function_extra = "{}"
        self.project_name = "AutoEdit"
        self.warnings = []


def build(plan: Plan, template, path_map: dict | None = None) -> BuildResult:
    res = BuildResult()
    res.project_name = plan.project_name
    now = int(time.time())
    reg = Registry(path_map)

    wes = copy.deepcopy(template.wesproj)
    main_tl = next(tl for tl in wes["timelineInfos"] if tl.get("type") == 0)
    main_tl_id = main_tl["timelineId"]

    # Fresh tracks (same layout/routing as the sample, no clips).
    main_tl["trackInfos"] = copy.deepcopy(template.track_protos)
    wes["timelineInfos"] = [main_tl]
    wes["resources"] = []
    wes["projectName"] = plan.project_name

    clip_map = {}          # instance GUID -> mediaId (for extra.json)
    next_sub_id = main_tl_id + 1

    # ---- narration audio ----------------------------------------------------
    narration_ticks = 0
    if plan.narration_audio:
        e = reg.get(plan.narration_audio)
        narration_ticks = e.info.duration_ticks
        plan.narration_ticks = narration_ticks
        if template.narration_clip is not None and template.narration_track_idx >= 0:
            clip = copy.deepcopy(template.narration_clip)
            clip["filename"] = e.doc_filename
            clip["sourceUuid"] = e.source_uuid
            clip["thisUId"] = uuid_lower()
            clip["tlBegin"], clip["tlEnd"] = 0, narration_ticks
            clip["inPoint"], clip["outPoint"] = 0, narration_ticks
            clip.pop("postTransition", None)
            inst = guid_upper()
            ud = clip.setdefault("userData", [])
            userdata_set(ud, 3, b64_str(inst, pad_to=64, null=True))
            userdata_set(ud, 10, b64_str(e.guid))
            userdata_set(ud, 50, b64_str(e.name))
            main_tl["trackInfos"][template.narration_track_idx]["clipList"].append(clip)
            clip_map[inst] = e.guid
        else:
            res.warnings.append("Template has no audio clip prototype; narration skipped.")

    # ---- visual items on the main video track --------------------------------
    vtrack = main_tl["trackInfos"][template.video_track_idx]["clipList"]
    items = sorted(plan.items, key=lambda i: i.tl_begin)
    for idx, item in enumerate(items):
        e = reg.get(item.path)
        proto = template.image_clip if item.kind == "image" else template.video_clip
        if proto is None:
            # sample lacked this kind; fall back to the other prototype
            proto = template.video_clip or template.image_clip
            res.warnings.append(
                f"No {item.kind} prototype in template; used generic prototype for {e.basename}.")
        clip = copy.deepcopy(proto)
        clip["filename"] = e.doc_filename
        clip["sourceUuid"] = e.source_uuid
        clip["thisUId"] = uuid_lower()
        clip["tlBegin"], clip["tlEnd"] = item.tl_begin, item.tl_end

        if item.kind == "image":
            in_pt = IMAGE_INPOINT_BASE
            clip["inPoint"] = in_pt
            clip["outPoint"] = in_pt + item.duration
            if isinstance(clip.get("speed"), dict):
                clip["speed"]["offset"] = round(in_pt / TICKS, 7)
                clip["speed"]["offsetEnd"] = round((in_pt + item.duration) / TICKS, 7)
        else:
            src_len = e.info.duration_ticks or item.duration
            in_pt = max(0, min(item.in_point, max(0, src_len - item.duration)))
            clip["inPoint"] = in_pt
            clip["outPoint"] = in_pt + item.duration
            if isinstance(clip.get("speed"), dict):
                clip["speed"]["offset"] = round(in_pt / TICKS, 7)
                clip["speed"]["offsetEnd"] = round((in_pt + item.duration) / TICKS, 7)

        # animation (only names harvested from the user's own sample)
        clip.pop("inAnimation", None)
        anim_applied = None
        if item.animation:
            anim = template.animations.get(item.animation.lower())
            if anim:
                clip["inAnimation"] = _retime_animation(anim, item.duration)
                anim_applied = item.animation
            else:
                res.warnings.append(f"Animation {item.animation!r} not in template; skipped.")

        # transition into the NEXT item (window centred on the boundary)
        clip.pop("postTransition", None)
        if item.transition and idx + 1 < len(items):
            tr = template.transitions.get(item.transition.lower())
            if tr:
                tr = copy.deepcopy(tr)
                width = tr["tlEnd"] - tr["tlBegin"]
                nxt = items[idx + 1]
                width = min(width, item.duration, nxt.duration)
                half = width // 2
                tr["tlBegin"] = item.tl_end - half
                tr["tlEnd"] = item.tl_end + (width - half)
                tr["thisUId"] = uuid_lower()
                clip["postTransition"] = tr
            else:
                res.warnings.append(f"Transition {item.transition!r} not in template; skipped.")

        inst = guid_upper()
        ud = clip.setdefault("userData", [])
        userdata_set(ud, 3, b64_str(inst, pad_to=64, null=True))
        userdata_set(ud, 10, b64_str(e.guid))
        userdata_set(ud, 50, b64_str(e.name))
        if anim_applied:
            userdata_set(ud, 13011, b64_str(anim_applied))
        vtrack.append(clip)
        clip_map[inst] = e.guid

    # ---- text overlays --------------------------------------------------------
    if plan.texts and (template.text_clip is None or template.text_subtimeline is None):
        res.warnings.append("Template has no text prototype; on-screen texts skipped. "
                            "Add one Title to the sample project and re-extract.")
    elif plan.texts:
        ttrack = main_tl["trackInfos"][template.text_track_idx]["clipList"]
        for t in sorted(plan.texts, key=lambda x: x.tl_begin):
            dur = t.tl_end - t.tl_begin
            if dur <= 0:
                continue
            sub = copy.deepcopy(template.text_subtimeline)
            sub_id = next_sub_id
            next_sub_id += 1
            sub["timelineId"] = sub_id
            for str_ in sub["trackInfos"]:
                str_["uuid"] = uuid_lower()
                for sc in str_.get("clipList", []):
                    sc["thisUId"] = uuid_lower()
                    sc["tlBegin"], sc["tlEnd"] = 0, dur
                    sc["inPoint"], sc["outPoint"] = 0, dur
                    # userData key 6 = id of the timeline that owns this clip
                    from .ids import b64_i32
                    userdata_set(sc.setdefault("userData", []), 6, b64_i32(sub_id))
                    if isinstance(sc.get("inAnimation"), dict):
                        sc["inAnimation"] = _retime_animation(sc["inAnimation"], dur)
                    if isinstance(sc.get("scriptBuf"), str) and sc["scriptBuf"]:
                        try:
                            script = json.loads(sc["scriptBuf"])
                            text = t.text.replace("\n", "\r")
                            script["Text"] = text
                            for td in script.get("TextData", []):
                                td["CharData"] = text
                            # Filmora writes scriptBuf compact; scriptBufSize
                            # must be byte length + 1 (verified against a real save)
                            sc["scriptBuf"] = json.dumps(
                                script, ensure_ascii=True, separators=(",", ":"))
                            sc["scriptBufSize"] = len(sc["scriptBuf"].encode("utf-8")) + 1
                        except Exception:
                            res.warnings.append("Could not edit text scriptBuf; kept sample text.")
            wes["timelineInfos"].append(sub)

            tclip = copy.deepcopy(template.text_clip)
            tclip["thisUId"] = uuid_lower()
            tclip["timelineId"] = sub_id
            tclip["tlBegin"], tclip["tlEnd"] = t.tl_begin, t.tl_end
            tclip["inPoint"], tclip["outPoint"] = 0, dur
            inst = guid_upper()
            userdata_set(tclip.setdefault("userData", []), 3, b64_str(inst, pad_to=64, null=True))
            ttrack.append(tclip)
            clip_map[inst] = "Basic_1"

    # ---- resources -------------------------------------------------------------
    for e in reg.entries:
        proto = template.resources.get(e.kind)
        if proto is None:
            proto = next(iter(template.resources.values()))
            res.warnings.append(f"No {e.kind} resource prototype; used generic for {e.basename}.")
        r = copy.deepcopy(proto)
        r["filename"] = "file:/" + e.original_path
        r["sourceUuid"] = e.source_uuid
        _patch_basic(r, e, now)
        _patch_stream_lists(r, e)
        wes["resources"].append(r)

    userdata_set(main_tl.setdefault("userData", []), 50, b64_str(plan.project_name, null=True))

    wes["currentTimelineId"] = main_tl_id
    wes["serialNumber"] = next_sub_id + 1

    duration = plan.duration

    # ---- medias_info.json --------------------------------------------------------
    tl_media_guid = guid_upper()
    res.timeline_media_guid = tl_media_guid
    tl_uuid = None
    # timeline_uuid must match wesproj main timeline userData key 11000; keep template's.
    from .ids import userdata_get_raw
    raw_uuid = userdata_get_raw(main_tl.get("userData", []), 11000)
    if raw_uuid:
        tl_uuid = raw_uuid.rstrip(b"\x00").decode("utf-8", "replace")

    media_type_by_kind = {"video": 8, "image": 16, "audio": 4}
    media_items = {}
    for e in reg.entries:
        media_items[e.guid] = {
            "download_url": e.original_path,
            "id": e.guid,
            "media_type": media_type_by_kind[e.kind],
            "media_length": e.info.duration_ticks if e.kind != "image" else 5 * TICKS,
            "name": e.name,
            "mediaCreationInfo": "{\"creationType\":0}",
            "import_time": now,
            "src_md5": e.md5,
            "stream_idx": 0 if e.kind != "image" else -1,
            "mark_info_list": [{"mark_in": -1, "mark_out": -1}],
            "scence_info": [],
        }
    media_items[tl_media_guid] = {
        "name": plan.project_name,
        "download_url": "",
        "id": tl_media_guid,
        "timeline_uuid": tl_uuid or guid_upper(),
        "media_type": 1048576,
        "create_time": now,
        "duration": duration,
        "enable_modify_mediaId": 0,
        "mark_info_list": [{"mark_in": -1, "mark_out": -1}],
    }
    media_structure = {
        "visible": "true",
        "SerializeDataOnlyProjectUsered": "false",
        "media_item": tl_media_guid,
    }
    audio_entries = [e for e in reg.entries if e.kind == "audio"]
    if audio_entries:
        media_structure = {
            "visible": "true",
            "SerializeDataOnlyProjectUsered": "false",
            "Folder": {
                "visible": "true",
                "SerializeDataOnlyProjectUsered": "false",
                "media_item": audio_entries[0].guid,
            },
            "media_item": tl_media_guid,
        }
    res.medias_info = {"media_structure": media_structure, "media_items": media_items}

    # ---- extra.json ------------------------------------------------------------
    extra = copy.deepcopy(template.extra_json)
    extra["mediaClipsMapInfo"] = {
        inst: {"mediaId": mid, "subClips": {}} for inst, mid in clip_map.items()}
    extra.setdefault("allMarkersInfo", {})["beatDetectInfo"] = {
        inst: {"algorithmType": 0, "level": 0} for inst in clip_map}
    extra["pendingMarkersInfo"] = {}
    extra["highlightInfo"] = {}
    res.extra_json = extra

    # ---- project_info.json --------------------------------------------------------
    pi = copy.deepcopy(template.project_info)
    pi["project_file_name"] = plan.project_name
    pi["project_date_create"] = now
    pi["project_date_modify"] = now
    pi["project_timeline_duration"] = duration
    pi["project_current_position"] = 0
    pi["project_guid"] = guid_upper()
    pi["timeline_mediaId"] = tl_media_guid
    pi["project_cover"] = False
    pi["project_custom_cover"] = False
    pi["project_backup"] = False
    old_name = template.project_info.get("project_file_name", "")
    zp = pi.get("proj_zip_save_path", "")
    if old_name and zp:
        pi["proj_zip_save_path"] = zp.replace(old_name + ".wfp", plan.project_name + ".wfp")
    cp = pi.get("proj_cover_proj_path", "")
    old_guid = template.project_info.get("project_guid", "")
    if old_guid and cp:
        pi["proj_cover_proj_path"] = cp.replace(old_guid, pi["project_guid"])
    res.project_info = pi

    res.wesproj = wes
    res.media_entries = reg.entries
    res.function_extra = template.function_extra
    return res
