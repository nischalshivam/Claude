"""Build and maintain the dialogue index (library.db).

One SQLite file holds every subtitle line of every movie/episode you own,
with the exact millisecond it is spoken. Building is incremental: files that
have not changed since the last scan are skipped, so adding a new season costs
seconds, not a rebuild.

No video is decoded here — this stage reads text only, which is why a whole
series indexes in minutes.
"""
from __future__ import annotations

import os
import re
import sqlite3
import time
import unicodedata
from dataclasses import dataclass

from . import naming, subtitles

SCHEMA_VERSION = 1

_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")

# Expanded on BOTH sides (index and query) so "doesn't" and "does not" match.
# A quoted line is very often remembered with the contraction opened out, and
# without this the pair scores ~76 instead of ~100.
_CONTRACTIONS = [
    (re.compile(r"(?i)\bwon't\b"), "will not"),
    (re.compile(r"(?i)\bcan't\b"), "can not"),
    (re.compile(r"(?i)\bshan't\b"), "shall not"),
    (re.compile(r"(?i)\bain't\b"), "is not"),
    (re.compile(r"(?i)\blet's\b"), "let us"),
    (re.compile(r"(?i)\bgonna\b"), "going to"),
    (re.compile(r"(?i)\bwanna\b"), "want to"),
    (re.compile(r"(?i)\bgotta\b"), "got to"),
    (re.compile(r"(?i)n't\b"), " not"),
    (re.compile(r"(?i)'ll\b"), " will"),
    (re.compile(r"(?i)'ve\b"), " have"),
    (re.compile(r"(?i)'re\b"), " are"),
    (re.compile(r"(?i)'m\b"), " am"),
]


def normalize(text: str) -> str:
    """Lowercase, strip accents/punctuation, expand contractions."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.replace("’", "'").replace("‘", "'")
    text = text.replace("“", '"').replace("”", '"')
    for pat, rep in _CONTRACTIONS:
        text = pat.sub(rep, text)
    text = _PUNCT.sub(" ", text.lower())
    return _WS.sub(" ", text).strip()


DDL = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS media (
    id          INTEGER PRIMARY KEY,
    path        TEXT UNIQUE NOT NULL,
    kind        TEXT NOT NULL,          -- episode | movie
    show        TEXT NOT NULL,
    show_norm   TEXT NOT NULL,
    year        INTEGER,
    season      INTEGER,
    episode     INTEGER,
    id_conf     TEXT,
    sub_kind    TEXT,                   -- sidecar | embedded | none
    sub_path    TEXT,
    sub_offset_ms INTEGER DEFAULT 0,    -- sync correction, applied on read
    cue_count   INTEGER DEFAULT 0,
    last_cue_ms INTEGER DEFAULT 0,
    file_size   INTEGER,
    file_mtime  INTEGER,
    indexed_at  INTEGER);

CREATE TABLE IF NOT EXISTS cue (
    id        INTEGER PRIMARY KEY,
    media_id  INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    idx       INTEGER NOT NULL,
    start_ms  INTEGER NOT NULL,
    end_ms    INTEGER NOT NULL,
    text      TEXT NOT NULL,
    text_norm TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS cue_media_idx ON cue(media_id, idx);
CREATE INDEX IF NOT EXISTS media_show    ON media(show_norm, season, episode);

CREATE VIRTUAL TABLE IF NOT EXISTS cue_fts USING fts5(
    text_norm, content='cue', content_rowid='id', tokenize='unicode61');
"""

TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS cue_ai AFTER INSERT ON cue BEGIN
  INSERT INTO cue_fts(rowid, text_norm) VALUES (new.id, new.text_norm);
END;
CREATE TRIGGER IF NOT EXISTS cue_ad AFTER DELETE ON cue BEGIN
  INSERT INTO cue_fts(cue_fts, rowid, text_norm) VALUES('delete', old.id, old.text_norm);
END;
"""


def connect(db_path: str) -> sqlite3.Connection:
    first = not os.path.exists(db_path)
    os.makedirs(os.path.dirname(os.path.abspath(db_path)) or ".", exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(DDL)
    con.executescript(TRIGGERS)
    if first:
        con.execute("INSERT OR REPLACE INTO meta VALUES ('schema', ?)",
                    (str(SCHEMA_VERSION),))
    con.commit()
    return con


@dataclass
class ScanResult:
    added: int = 0
    updated: int = 0
    skipped: int = 0
    no_subs: list = None          # [(path, reason)]
    cues: int = 0
    seconds: float = 0.0

    def __post_init__(self):
        if self.no_subs is None:
            self.no_subs = []


def _index_one(con, path: str, log) -> tuple[str, int]:
    """Index a single video. Returns (status, cue_count)."""
    st = os.stat(path)
    row = con.execute(
        "SELECT id, file_size, file_mtime FROM media WHERE path=?", (path,)).fetchone()
    if row and row["file_size"] == st.st_size and row["file_mtime"] == int(st.st_mtime):
        return "skipped", 0

    mid = naming.parse(path)
    kind, sub_path, cues = subtitles.load_for_video(path)

    if row:
        con.execute("DELETE FROM cue WHERE media_id=?", (row["id"],))
        media_id = row["id"]
        con.execute(
            """UPDATE media SET kind=?,show=?,show_norm=?,year=?,season=?,episode=?,
                   id_conf=?,sub_kind=?,sub_path=?,cue_count=?,last_cue_ms=?,
                   file_size=?,file_mtime=?,indexed_at=? WHERE id=?""",
            (mid.kind, mid.show, normalize(mid.show), mid.year, mid.season,
             mid.episode, mid.confidence, kind, sub_path, len(cues),
             cues[-1].end_ms if cues else 0, st.st_size, int(st.st_mtime),
             int(time.time()), media_id))
        status = "updated"
    else:
        cur = con.execute(
            """INSERT INTO media(path,kind,show,show_norm,year,season,episode,
                   id_conf,sub_kind,sub_path,cue_count,last_cue_ms,
                   file_size,file_mtime,indexed_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (path, mid.kind, mid.show, normalize(mid.show), mid.year, mid.season,
             mid.episode, mid.confidence, kind, sub_path, len(cues),
             cues[-1].end_ms if cues else 0, st.st_size, int(st.st_mtime),
             int(time.time())))
        media_id = cur.lastrowid
        status = "added"

    con.executemany(
        "INSERT INTO cue(media_id,idx,start_ms,end_ms,text,text_norm) VALUES(?,?,?,?,?,?)",
        [(media_id, c.idx, c.start_ms, c.end_ms, c.text, normalize(c.text))
         for c in cues if normalize(c.text)])
    return status, len(cues)


def build(media_root: str, db_path: str, log=print) -> ScanResult:
    """Scan `media_root` and bring `db_path` up to date."""
    t0 = time.time()
    res = ScanResult()
    con = connect(db_path)
    files = list(naming.walk_media(media_root))
    log(f"scanning {len(files)} video file(s) under {media_root}")

    for i, path in enumerate(files, 1):
        try:
            status, n = _index_one(con, path, log)
        except Exception as exc:                       # never abort a bulk scan
            log(f"  ERROR {os.path.basename(path)}: {exc}")
            res.no_subs.append((path, f"error: {exc}"))
            continue
        if status == "skipped":
            res.skipped += 1
            continue
        setattr(res, status, getattr(res, status) + 1)
        res.cues += n
        mid = naming.parse(path)
        if n == 0:
            res.no_subs.append((path, "no subtitles found"))
            log(f"  [{i}/{len(files)}] {mid.label}  —  NO SUBTITLES")
        else:
            log(f"  [{i}/{len(files)}] {mid.label}  —  {n} lines")
        if i % 25 == 0:
            con.commit()

    con.commit()
    con.execute("INSERT OR REPLACE INTO meta VALUES ('last_scan', ?)",
                (str(int(time.time())),))
    con.commit()
    con.close()
    res.seconds = time.time() - t0
    return res


def stats(db_path: str) -> dict:
    con = connect(db_path)
    q = lambda s: con.execute(s).fetchone()[0]
    out = {
        "media_files": q("SELECT COUNT(*) FROM media"),
        "with_subs": q("SELECT COUNT(*) FROM media WHERE cue_count>0"),
        "without_subs": q("SELECT COUNT(*) FROM media WHERE cue_count=0"),
        "dialogue_lines": q("SELECT COUNT(*) FROM cue"),
        "shows": q("SELECT COUNT(DISTINCT show_norm) FROM media"),
        "db_bytes": os.path.getsize(db_path) if os.path.exists(db_path) else 0,
    }
    out["titles"] = [dict(r) for r in con.execute(
        """SELECT show, kind, COUNT(*) files, SUM(cue_count) lines,
                  MIN(season) s_min, MAX(season) s_max
           FROM media GROUP BY show_norm ORDER BY show""")]
    con.close()
    return out
