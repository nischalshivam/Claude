"""The tool in a browser.

A terminal menu can ask questions and print numbers. It cannot show you a
picture, and every problem this tool has left is a problem you can only see:
a shot from the wrong scene, a still that sits too long, a beat with nothing
in it. Six builds were spent describing those to each other in text when a
single glance would have settled them.

So this serves the same data the menu already produces — the manifest, the
timeline, the library — as pages you can look at, with the actual frames on
screen.

## Why the standard library and nothing else

The tool installs from a zip on a Windows machine with no build tools. Every
dependency so far has been either optional (torch, faster-whisper) or a
single wheel (numpy). A web framework would be neither, and a browser page
that needs `pip install` before it opens is not a page anyone will use.
`http.server` is enough: this serves one machine, one person, over
localhost, and the heavy lifting is all in files that already exist on disk.

## What it will not do

It does not hold state. Every page reads the same folders the menu writes,
so the browser and the menu can be open at once and neither can confuse the
other. Nothing here is a second source of truth.
"""
from __future__ import annotations

import http.server
import json
import os
import posixpath
import socket
import socketserver
import threading
import urllib.parse
import webbrowser

from . import builds, jobs as jobs_mod, libraries, library, sources, term

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "web_ui.html")
UI = os.path.join(HERE, "ui")
# The design lives one folder up from the package, beside the brief it was
# written from, because it is not code: it is the drawing the screens are
# built to match, and it gets replaced wholesale when it is redesigned.
DESIGN = os.path.join(os.path.dirname(HERE), "design", "Movie Editor.dc.html")
# Served by name, never by path. The page asks for /ui/app.js, not for a file.
ASSETS = {"app": ("app.html", "text/html; charset=utf-8"),
          "app.js": ("app.js", "text/javascript; charset=utf-8"),
          "dcx.js": ("dcx.js", "text/javascript; charset=utf-8"),
          "screens": ("screens.html", "text/html; charset=utf-8")}
DEFAULT_PORT = 8712
# Files the browser is allowed to ask for, by extension. A local server is
# still a server: it should never hand out a database or a script because a
# URL asked nicely.
SERVABLE = (".mp4", ".jpg", ".jpeg", ".png", ".m4a", ".mp3", ".txt")
TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".png": "image/png", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
         ".txt": "text/plain; charset=utf-8"}


def _read_json(path: str):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def build_folder(out: str) -> dict:
    """Everything one output folder knows about itself.

    The manifest says what was cut and where each asset came from; the
    timeline says when each one is on screen. Neither is complete on its
    own, and the browser needs both at once — so they are joined here rather
    than in the page, where a mistake would be invisible.
    """
    out = os.path.abspath(out)
    manifest = _read_json(os.path.join(out, "manifest.json")) or {}
    timeline = _read_json(os.path.join(out, "timeline.json")) or {}
    video = os.path.join(out, "video.mp4")

    facts = {}
    for scene in (manifest.get("scenes") or []):
        for a in (scene.get("assets") or []):
            facts[(scene.get("scene"), a.get("file"))] = a

    scenes = []
    for s in (timeline.get("scenes") or []):
        items = []
        for i in (s.get("items") or []):
            known = facts.get((s.get("scene"), i.get("file")), {})
            items.append({
                "file": i.get("file", ""),
                "kind": i.get("kind", "image"),
                "start": round(float(i.get("start") or 0.0), 2),
                "duration": round(float(i.get("duration") or 0.0), 2),
                "source": i.get("source") or known.get("source") or "",
                "source_start": i.get("source_start"),
                "placed_by": i.get("placed_by") or known.get("placed_by", ""),
                "confidence": i.get("confidence", ""),
                "url": f"/file?out={urllib.parse.quote(out)}&"
                       f"rel={urllib.parse.quote('scene_%03d/%s' % (s.get('scene') or 0, i.get('file','')))}",
            })
        scenes.append({
            "scene": s.get("scene"),
            "narration": s.get("narration", ""),
            "start": round(float(s.get("start") or 0.0), 2),
            "end": round(float(s.get("end") or 0.0), 2),
            "note": s.get("note", ""),
            "items": items,
        })

    counts: dict = {}
    for s in scenes:
        for i in s["items"]:
            key = i["placed_by"] or "unknown"
            counts[key] = counts.get(key, 0) + 1
    return {
        "out": out,
        "video": timeline.get("video", "") or manifest.get("video", ""),
        "audio": timeline.get("audio", ""),
        "total_seconds": round(float(timeline.get("total_seconds") or 0.0), 2),
        "pace": timeline.get("pace", ""),
        "scenes": scenes,
        "counts": counts,
        "empty": sum(1 for s in scenes if not s["items"]),
        "rendered": (f"/file?out={urllib.parse.quote(out)}&rel=video.mp4"
                     if os.path.isfile(video) else ""),
        "has_manifest": bool(manifest),
        "has_timeline": bool(timeline),
    }


# Folders and files a picker will show. A browser cannot open a native file
# dialog from a page, so the tool has to do the walking itself — and it
# should only ever offer the kinds of file the field is actually for.
PICK = {"script": (".json",),
        "audio": (".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg"),
        "folder": ()}


def script_facts(path: str) -> dict:
    """What a script says about itself, read the moment it is chosen.

    This is the one number that tells someone the tool understood the file
    they just picked. Getting it after a forty-minute build is not the same
    information.
    """
    beats = jobs_mod.read_beats(path)
    shots = sum(len(b.get("shots") or []) for b in beats)
    reqs = sources.requirements(beats)
    # `episodes_declared` holds (season, episode) pairs. Handing those to a
    # page as-is puts "1,1, 1,3" on screen, which is not a thing anyone has
    # ever called an episode.
    episodes = sorted({se for r in reqs for se in r.episodes_declared})
    labelled = [f"S{int(s):02d}E{int(e):02d}" for s, e in episodes]
    return {"path": os.path.abspath(path), "beats": len(beats),
            "shots": shots, "titles": [r.title for r in reqs],
            "episodes": labelled[:24], "episodes_total": len(labelled)}


def audio_facts(path: str) -> dict:
    from .probe import ProbeError, probe
    try:
        info = probe(path)
    except ProbeError as exc:
        return {"path": os.path.abspath(path), "error": str(exc)[:200]}
    return {"path": os.path.abspath(path), "seconds": round(info.duration, 1)}


def browse(path: str, kind: str = "folder") -> dict:
    """One folder's worth of somewhere to go next.

    Deliberately not rooted anywhere: the whole point is choosing a script
    on D: and a library on E:. It only ever LISTS — nothing here opens,
    writes or deletes a thing, and the extensions offered are the field's.
    """
    here = os.path.abspath(path or os.path.expanduser("~"))
    # Walk up until something is really there. The remembered folder from
    # last session may have been deleted, and so may its parent — a picker
    # that opens on a folder that does not exist shows nothing and looks
    # broken, when all that happened is someone tidied their drive.
    while not os.path.isdir(here):
        parent = os.path.dirname(here)
        if parent == here:
            here = os.path.abspath(os.sep)
            break
        here = parent
    wanted = PICK.get(kind, ())
    folders, files = [], []
    try:
        for name in sorted(os.listdir(here), key=str.lower):
            full = os.path.join(here, name)
            try:
                if os.path.isdir(full):
                    if not name.startswith("."):
                        folders.append({"name": name, "path": full})
                elif wanted and os.path.splitext(name)[1].lower() in wanted:
                    files.append({"name": name, "path": full,
                                  "size": os.path.getsize(full)})
            except OSError:
                continue                    # a permission wall is not an error
    except OSError as exc:
        return {"path": here, "error": str(exc)[:200],
                "folders": [], "files": [], "up": os.path.dirname(here)}
    up = os.path.dirname(here)
    return {"path": here, "up": up if up != here else "",
            "folders": folders, "files": files,
            "drives": _drives()}


def _drives() -> list:
    """Every drive letter that exists, on the machine this actually runs on.

    D: holds the footage and E: the libraries; a picker that cannot leave
    one of them is a picker nobody can use.
    """
    if os.name != "nt":
        return [{"name": "/", "path": os.path.abspath(os.sep)}]
    found = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        root = f"{letter}:\\"
        if os.path.isdir(root):
            found.append({"name": f"{letter}:", "path": root})
    return found


def library_facts(db_path: str) -> dict:
    try:
        stats = library.stats(db_path)
    except Exception as exc:                # a missing database is an answer
        return {"error": str(exc)[:200], "db": os.path.abspath(db_path)}
    stats["db"] = os.path.abspath(db_path)
    return stats


# One runner for the process. Builds are serialised inside it: two at once
# would fight over ffmpeg and the disk and finish slower than one after the
# other.
RUNNER = builds.Runner()


class Handler(http.server.SimpleHTTPRequestHandler):
    db_path = "library.db"
    out_path = ""
    libraries_root = ""

    def log_message(self, *_a):             # the terminal stays readable
        pass

    def _send(self, code: int, body: bytes, kind: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass                            # the tab was closed mid-download

    def _json(self, data, code: int = 200) -> None:
        self._send(code, json.dumps(data).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self) -> None:               # noqa: N802 (stdlib spelling)
        parts = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parts.query)
        route = parts.path

        if route in ("/", "/index.html"):
            self._serve_asset("app")
            return

        # The shot-by-shot page the tool has had since the sixth build. The
        # app has not replaced it yet, and taking away a page that works in
        # order to show one that is half built is not an upgrade.
        if route in ("/shots", "/shots.html"):
            try:
                with open(PAGE, "rb") as f:
                    self._send(200, f.read(), "text/html; charset=utf-8")
            except OSError as exc:
                self._send(500, str(exc).encode(), "text/plain")
            return

        if route == "/favicon.ico":
            self._send(204, b"", "image/x-icon")     # asked for by every tab
            return

        if route.startswith("/ui/"):
            self._serve_asset(route[4:])
            return

        if route == "/api/titles":
            self._json(libraries.catalogue(self.libraries_root, self.db_path))
            return

        if route == "/api/script":
            path = (query.get("path") or [""])[0].strip()
            if not os.path.isfile(path):
                self._json({"error": f"no such file: {path}"}, 404)
                return
            try:
                self._json(script_facts(path))
            except Exception as exc:
                # A script that will not parse is the single most common way
                # a build fails, and it fails here rather than forty minutes
                # in. The message is the parser's own, which names the line.
                self._json({"error": str(exc)[:300]}, 400)
            return

        if route == "/api/audio":
            path = (query.get("path") or [""])[0].strip()
            if not os.path.isfile(path):
                self._json({"error": f"no such file: {path}"}, 404)
                return
            self._json(audio_facts(path))
            return

        if route == "/api/browse":
            self._json(browse((query.get("path") or [""])[0],
                              (query.get("kind") or ["folder"])[0]))
            return

        if route == "/api/task":
            task = RUNNER.get((query.get("id") or [""])[0])
            if not task:
                self._json({"error": "no such task"}, 404)
                return
            self._json(task.as_dict())
            return

        if route == "/api/tasks":
            self._json({"tasks": RUNNER.all()})
            return

        if route == "/api/start":
            self._json({"db": os.path.abspath(self.db_path),
                        "out": self.out_path})
            return

        if route == "/api/library":
            self._json(library_facts(self.db_path))
            return

        if route == "/api/build":
            out = (query.get("out") or [""])[0].strip()
            if not out:
                self._json({"error": "no folder given"}, 400)
                return
            if not os.path.isdir(out):
                self._json({"error": f"no such folder: {out}"}, 404)
                return
            self._json(build_folder(out))
            return

        if route == "/file":
            self._serve_file(query)
            return

        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:              # noqa: N802 (stdlib spelling)
        route = urllib.parse.urlsplit(self.path).path
        try:
            length = int(self.headers.get("Content-Length") or 0)
            spec = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError) as exc:
            self._json({"error": f"unreadable request: {exc}"}, 400)
            return
        if not isinstance(spec, dict):
            self._json({"error": "expected an object"}, 400)
            return

        if route == "/api/check":
            self._json(builds.check(RUNNER, spec, self.db_path).as_dict())
            return
        if route == "/api/build":
            self._json(builds.build(RUNNER, spec, self.db_path).as_dict())
            return
        self._send(404, b"not found", "text/plain")

    def _serve_asset(self, name: str) -> None:
        """The app's own files, by name from a fixed list.

        Never by path. `/ui/` reaches into the package itself, and a route
        that took a file name from the URL would be a way to read the source
        — or anything else on the machine — from a browser tab.
        """
        if name == "design":
            path, kind = DESIGN, "text/html; charset=utf-8"
        elif name in ASSETS:
            path, kind = os.path.join(UI, ASSETS[name][0]), ASSETS[name][1]
        else:
            self._send(404, b"no such asset", "text/plain")
            return
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError as exc:
            self._send(404, str(exc).encode(), "text/plain")
            return
        self._send(200, body, kind)

    def _serve_file(self, query) -> None:
        out = (query.get("out") or [""])[0]
        rel = (query.get("rel") or [""])[0]
        root = os.path.abspath(out)
        # posixpath.normpath on the RELATIVE part only, then join: a `rel` of
        # "../../library.db" cannot escape, because the result is checked to
        # still live under the folder the page asked for.
        target = os.path.abspath(os.path.join(root, *posixpath.normpath(rel).split("/")))
        if not target.startswith(root + os.sep):
            self._send(403, b"outside the output folder", "text/plain")
            return
        if os.path.splitext(target)[1].lower() not in SERVABLE:
            self._send(403, b"not a servable file", "text/plain")
            return
        if not os.path.isfile(target):
            self._send(404, b"no such file", "text/plain")
            return
        kind = TYPES.get(os.path.splitext(target)[1].lower(),
                         "application/octet-stream")
        try:
            with open(target, "rb") as f:
                body = f.read()
        except OSError as exc:
            self._send(500, str(exc).encode(), "text/plain")
            return
        self._send(200, body, kind)


class Server(socketserver.ThreadingTCPServer):
    """Threaded: a page holding a video open must not block the next click."""
    allow_reuse_address = True
    daemon_threads = True


def free_port(start: int = DEFAULT_PORT, tries: int = 20) -> int:
    """The first port nothing else is on. A second copy of the tool should
    open rather than crash with 'address already in use'."""
    for port in range(start, start + tries):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


def serve(db_path: str = "library.db", out: str = "", port: int = 0,
          open_browser: bool = True, log=print, libraries_root: str = "") -> None:
    """Run until interrupted. Localhost only — never the network."""
    Handler.db_path = db_path
    Handler.out_path = os.path.abspath(out) if out else ""
    Handler.libraries_root = libraries_root
    port = port or free_port()
    url = f"http://127.0.0.1:{port}/"
    d = term.sym("dot")
    with Server(("127.0.0.1", port), Handler) as httpd:
        log(f"  the tool is open at {url}")
        log(f"  library {d} {os.path.abspath(db_path)}")
        if Handler.out_path:
            log(f"  video   {d} {Handler.out_path}")
        log("  leave this window open while you use it; Ctrl+C closes it")
        if open_browser:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            log("\n  closed")
