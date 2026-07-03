"""Package a BuildResult into a .wfpbundle (what Filmora calls a packaged project).

Layout and byte-level conventions verified against a real Filmora 15.6.4 save:
  - both zips STORED (no compression)
  - JSON written compact (no spaces) with ASCII escapes, like Filmora does
  - inner .wfp entry order mirrors Filmora's writer:
      per-media media.json (+thumbnail.png) → timeline thumbnail →
      functionExtraData → medias_info → extra.json → timeline.wesproj →
      project_info.json → Anon/Cover/thumb.fsthumb
  - outer bundle: Medias/{GUID}/<file> …, <Name>.wfp last

  <out>.wfpbundle
    Medias/{MEDIA-GUID}/<file>         actual media bytes
    <Name>.wfp                         (inner zip)
      ProjectFolder/…                  (see above)
"""
from __future__ import annotations

import base64
import copy
import io
import json
import os
import tempfile
import time
import zipfile

from .timeline import BuildResult, _patch_basic, _patch_stream_lists


def _media_json(template, e, now: int) -> dict:
    proto = template.media_jsons.get(e.kind)
    if proto is None:
        proto = next(iter(template.media_jsons.values()))
    mj = copy.deepcopy(proto)
    mj["file_name"] = e.original_path
    src = mj.get("sourceInfo", {})
    _patch_basic(src.get("basicInfo", {}), e, now)
    _patch_stream_lists(src, e)
    if e.kind == "video" and not e.info.has_audio:
        src["audStreamInfos"] = []
        src.get("basicInfo", {})["audioStreamCount"] = 0
    return mj


def _j(obj) -> bytes:
    # Filmora writes compact JSON with ASCII escapes (no raw UTF-8 bytes).
    return json.dumps(obj, ensure_ascii=True, separators=(",", ":")).encode("utf-8")


class _FilmoraZip:
    """Zip writer that mimics the metadata of Filmora's own zips
    (STORED, create_version 63, extract_version 10, unix perms rw-)."""

    def __init__(self, fileobj):
        self.z = zipfile.ZipFile(fileobj, "w", zipfile.ZIP_STORED)
        self.dt = time.localtime()[:6]

    def add(self, arcname: str, data: bytes):
        zi = zipfile.ZipInfo(arcname, date_time=self.dt)
        zi.compress_type = zipfile.ZIP_STORED
        zi.create_system = 3
        zi.create_version = 63
        zi.extract_version = 10
        zi.external_attr = 0x81B60000  # -rw-rw-rw- (matches Filmora saves)
        self.z.writestr(zi, data)

    def add_file(self, arcname: str, path: str):
        with open(path, "rb") as f:
            self.add(arcname, f.read())

    def close(self):
        self.z.close()


def write_bundle(result: BuildResult, template, out_path: str,
                 thumbnails: bool = True, log=print) -> str:
    if not out_path.lower().endswith(".wfpbundle"):
        out_path += ".wfpbundle"
    now = int(time.time())
    name = result.project_name
    tl_guid = result.timeline_media_guid
    binaries = getattr(template, "binaries", {}) or {}

    # ---- inner .wfp (entry order mirrors Filmora's writer) ----
    inner_buf = io.BytesIO()
    zin = _FilmoraZip(inner_buf)
    for e in result.media_entries:
        zin.add(f"ProjectFolder/Medias/{e.guid}/media.json",
                _j(_media_json(template, e, now)))
        if thumbnails:
            from .probe import make_thumbnail
            with tempfile.TemporaryDirectory() as td:
                png = os.path.join(td, "thumb.png")
                if make_thumbnail(e.path, png, e.kind):
                    with open(png, "rb") as f:
                        zin.add(f"ProjectFolder/Medias/{e.guid}/thumbnail.png", f.read())
    if binaries.get("tl_thumbnail_png"):
        zin.add(f"ProjectFolder/Medias/{tl_guid}/thumbnail.png",
                base64.b64decode(binaries["tl_thumbnail_png"]))
    zin.add("ProjectFolder/Anon/AppData/Windows/functionExtraData.json",
            result.function_extra.encode("utf-8"))
    zin.add("ProjectFolder/Medias/medias_info.json", _j(result.medias_info))
    zin.add(f"ProjectFolder/Medias/{tl_guid}/extra.json", _j(result.extra_json))
    zin.add(f"ProjectFolder/Medias/{tl_guid}/timeline.wesproj", _j(result.wesproj))
    zin.add("ProjectFolder/project_info.json", _j(result.project_info))
    if binaries.get("cover_fsthumb"):
        zin.add("ProjectFolder/Anon/Cover/thumb.fsthumb",
                base64.b64decode(binaries["cover_fsthumb"]))
    zin.close()

    # ---- outer bundle ----
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        zout = _FilmoraZip(f)
        for e in result.media_entries:
            zout.add_file(f"Medias/{e.guid}/{e.basename}", e.path)
            log(f"  packed media: {e.basename}")
        zout.add(f"{name}.wfp", inner_buf.getvalue())
        zout.close()
    log(f"  wrote {out_path} ({os.path.getsize(out_path) / 1e6:.1f} MB)")
    return out_path
