"""Package a BuildResult into a .wfpbundle (what Filmora calls a packaged project).

Layout (verified against a real Filmora 15.6.4 save):
  <out>.wfpbundle                      (zip, stored)
    Medias/{MEDIA-GUID}/<file>         actual media bytes
    <Name>.wfp                         (inner zip, stored)
      ProjectFolder/project_info.json
      ProjectFolder/Medias/medias_info.json
      ProjectFolder/Medias/{TL-GUID}/timeline.wesproj
      ProjectFolder/Medias/{TL-GUID}/extra.json
      ProjectFolder/Medias/{MEDIA-GUID}/media.json  (+ thumbnail.png)
      ProjectFolder/Anon/AppData/Windows/functionExtraData.json
"""
from __future__ import annotations

import copy
import io
import json
import os
import tempfile
import time
import zipfile

from .timeline import BuildResult, _patch_basic, _patch_stream_lists, _win_path


def _media_json(template, e, now: int) -> dict:
    proto = template.media_jsons.get(e.kind)
    if proto is None:
        proto = next(iter(template.media_jsons.values()))
    mj = copy.deepcopy(proto)
    mj["file_name"] = _win_path(e.path)
    src = mj.get("sourceInfo", {})
    _patch_basic(src.get("basicInfo", {}), e, now)
    _patch_stream_lists(src, e)
    if e.kind == "video" and not e.info.has_audio:
        src["audStreamInfos"] = []
        src.get("basicInfo", {})["audioStreamCount"] = 0
    return mj


def write_bundle(result: BuildResult, template, out_path: str,
                 thumbnails: bool = True, log=print) -> str:
    if not out_path.lower().endswith(".wfpbundle"):
        out_path += ".wfpbundle"
    now = int(time.time())
    name = result.project_name
    tl_guid = result.timeline_media_guid

    def j(obj) -> bytes:
        return json.dumps(obj, ensure_ascii=False).encode("utf-8")

    # ---- inner .wfp ----
    inner_buf = io.BytesIO()
    with zipfile.ZipFile(inner_buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("ProjectFolder/project_info.json", j(result.project_info))
        z.writestr("ProjectFolder/Anon/AppData/Windows/functionExtraData.json",
                   result.function_extra)
        z.writestr("ProjectFolder/Medias/medias_info.json", j(result.medias_info))
        z.writestr(f"ProjectFolder/Medias/{tl_guid}/timeline.wesproj", j(result.wesproj))
        z.writestr(f"ProjectFolder/Medias/{tl_guid}/extra.json", j(result.extra_json))
        for e in result.media_entries:
            z.writestr(f"ProjectFolder/Medias/{e.guid}/media.json",
                       j(_media_json(template, e, now)))
            if thumbnails:
                from .probe import make_thumbnail
                with tempfile.TemporaryDirectory() as td:
                    png = os.path.join(td, "thumb.png")
                    if make_thumbnail(e.path, png, e.kind):
                        with open(png, "rb") as f:
                            z.writestr(f"ProjectFolder/Medias/{e.guid}/thumbnail.png",
                                       f.read())

    # ---- outer bundle ----
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_STORED) as z:
        for e in result.media_entries:
            z.write(e.path, f"Medias/{e.guid}/{e.basename}")
            log(f"  packed media: {e.basename}")
        z.writestr(f"{name}.wfp", inner_buf.getvalue())
    log(f"  wrote {out_path} ({os.path.getsize(out_path) / 1e6:.1f} MB)")
    return out_path
