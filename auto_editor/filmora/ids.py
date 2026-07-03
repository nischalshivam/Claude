"""GUID/uuid helpers matching Filmora's on-disk conventions.

Filmora uses three id shapes:
- media/instance GUIDs:   {UPPERCASE-8-4-4-4-12}   (medias_info, extra.json, userData)
- object uuids:           lowercase 8-4-4-4-12     (thisUId, track uuid, sourceUuid)
- userData entries: little binary/text blobs, base64-encoded, null-padded to `size`.
"""
from __future__ import annotations

import base64
import struct
import uuid


def guid_upper() -> str:
    return "{" + str(uuid.uuid4()).upper() + "}"


def uuid_lower() -> str:
    return str(uuid.uuid4())


def b64_str(text: str, pad_to: int | None = None) -> dict:
    """Encode a string the way Filmora stores it in userData: null-terminated,
    optionally null-padded to a fixed size. Returns {data,size} fields."""
    raw = text.encode("utf-8") + b"\x00"
    if pad_to is not None and len(raw) < pad_to:
        raw = raw + b"\x00" * (pad_to - len(raw))
    return {"data": base64.b64encode(raw).decode("ascii"), "size": len(raw)}


def b64_i32(value: int) -> dict:
    raw = struct.pack("<i", value)
    return {"data": base64.b64encode(raw).decode("ascii"), "size": 4}


def userdata_set(userdata: list, key: int, fields: dict) -> None:
    """Replace (or insert) the entry with `key` in a Filmora userData list."""
    for entry in userdata:
        if entry.get("key") == key:
            entry.update(fields)
            return
    userdata.append({"key": key, **fields})


def userdata_get_raw(userdata: list, key: int) -> bytes | None:
    for entry in userdata:
        if entry.get("key") == key:
            data = entry.get("data", "")
            return base64.b64decode(data + "=" * (-len(data) % 4))
    return None
