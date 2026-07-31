"""A vision model that looks at candidate frames and picks the right one.

This is the one thing local retrieval genuinely cannot do, proven on a real
build. The "Why Gus Killed Victor Without a Word" essay is 36 beats, and
twenty of them are **silent** — a man changes his clothes, picks up a box
cutter, cuts a throat, rings a bell, straightens his tie. No dialogue means
no anchor, so those twenty beats were placed by interpolating between distant
spoken lines, and they landed minutes from where they belong: the bell,
really at 37:42, was laid at 32:25.

Local picture search (SigLIP) was asked and abstained — "the picture has no
opinion about where this run happens." It scores a frame against a caption
and, on these scenes, the right frame does not beat the noise floor. That is
its honest ceiling.

A large vision model does not have that ceiling. Shown twelve frames and
asked "which one shows an old man's hand striking a small bell", it answers.
So the division of labour is exact, and it is the one the GPT handoff argued
for:

    local dialogue search   -> WHICH scene, to the millisecond, when a line
                               of that scene was spoken
    this module             -> WHICH frame inside a candidate window, when
                               nothing was spoken

It is a **verifier and reranker, never a source of truth.** It is never
asked "where in this movie is X" — that fails, it is slow, and it
hallucinates. It is only ever handed a bounded window that local retrieval
already chose, a handful of frames sampled from it, and a yes/which
question. If it is not configured, errors, or abstains, the build is exactly
the build that ran without it. Nothing here can ever make a build worse than
interpolation already was; it can only move a guessed shot onto a frame a
model actually looked at.

## Configuration

Read from `settings.txt` beside the tool (or environment), never from code:

    gemini_key=<your-secret-key>
    gemini_base=https://.../v1
    gemini_model=gemini-2.5-flash

The key is a secret and lives only in that file, which is not in the
repository. This module never logs it and never writes it anywhere.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass

# OpenAI-compatible chat-completions is what the proxy speaks, so the request
# shape here is the same one every such endpoint accepts: a model, a list of
# messages, and image parts carried as data: URIs.
DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_TIMEOUT_S = 60
# A verdict below this is treated as "not sure", and the shot keeps the
# position interpolation already gave it rather than moving on a weak guess.
MIN_CONFIDENCE = 0.55


def _settings_file() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "settings.txt")


def _from_settings() -> dict:
    """The `key=value` lines of settings.txt, or {} if there is no file.

    Parsed the same way start.bat writes it, so a value with an `=` in it
    (a URL query, say) keeps everything after the first `=`.
    """
    out: dict = {}
    try:
        with open(_settings_file(), "r", encoding="utf-8-sig") as f:
            for line in f:
                if "=" in line and not line.lstrip().startswith("#"):
                    k, v = line.split("=", 1)
                    out[k.strip().lower()] = v.strip()
    except OSError:
        return {}
    return out


@dataclass
class Config:
    key: str = ""
    base: str = ""
    model: str = DEFAULT_MODEL

    @property
    def ok(self) -> bool:
        return bool(self.key and self.base)

    @property
    def endpoint(self) -> str:
        return self.base.rstrip("/") + "/chat/completions"


def config() -> Config:
    """Environment first, then settings.txt. Secrets never come from code."""
    s = _from_settings()
    return Config(
        key=os.environ.get("GEMINI_API_KEY") or s.get("gemini_key", ""),
        base=os.environ.get("GEMINI_BASE_URL") or s.get("gemini_base", ""),
        model=os.environ.get("GEMINI_MODEL") or s.get("gemini_model")
        or DEFAULT_MODEL,
    )


def available() -> tuple:
    """(usable, why-not). Never raises, so a caller can guard cheaply."""
    cfg = config()
    if not cfg.key:
        return False, "gemini_key settings.txt me nahi hai"
    if not cfg.base:
        return False, "gemini_base (endpoint URL) settings.txt me nahi hai"
    return True, ""


# ---------------------------------------------------------------------------
# the question, and the answer
# ---------------------------------------------------------------------------

@dataclass
class Frame:
    """One candidate the model may choose. `at_s` is real episode time."""
    at_s: float
    jpeg: bytes


@dataclass
class Choice:
    """What the model decided, already sanity-checked."""
    index: int = -1                 # which frame, or -1 for "none of them"
    at_s: float = 0.0
    confidence: float = 0.0
    reason: str = ""

    @property
    def chose(self) -> bool:
        return self.index >= 0 and self.confidence >= MIN_CONFIDENCE


def _data_uri(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")


def build_messages(intent: str, must_be_visible: list, frames: list) -> list:
    """The prompt. One system rule, then the frames, numbered, then the ask.

    The numbering matters: the model is told to answer with the frame's
    number and nothing generative decides position — the number maps back to
    a real timestamp this module already knows.
    """
    people = ", ".join(must_be_visible) if must_be_visible else ""
    rules = (
        "You are choosing which of several still frames best matches a "
        "moment described for a video essay. The frames are numbered, in "
        "order, and are all from the correct scene. Choose the ONE frame "
        "that best shows the described moment.\n\n"
        "Answer ONLY with strict JSON:\n"
        '{\"frame\": <number or -1>, \"confidence\": <0..1>, '
        '\"reason\": \"<short>\"}\n\n'
        "Rules:\n"
        "- Judge only what is visibly in the frame. Do not guess.\n"
        "- If NONE of the frames clearly shows the moment, answer frame -1.\n"
        "- confidence is how sure you are the chosen frame shows it."
    )
    ask = f"The moment: {intent}"
    if people:
        ask += f"\nMust be visible on screen: {people}"
    ask += f"\n\nThere are {len(frames)} frames, numbered 1 to {len(frames)}."

    content = [{"type": "text", "text": ask}]
    for i, fr in enumerate(frames, 1):
        content.append({"type": "text", "text": f"Frame {i}:"})
        content.append({"type": "image_url",
                        "image_url": {"url": _data_uri(fr.jpeg)}})
    return [
        {"role": "system", "content": rules},
        {"role": "user", "content": content},
    ]


def parse_verdict(text: str, frames: list) -> Choice:
    """The model's JSON answer, mapped back to a real timestamp.

    Tolerant of the usual chat-model wrapping — a fenced block, a stray
    sentence before the brace — because the useful content is the object and
    losing a good answer to a code fence would be a poor trade.
    """
    raw = (text or "").strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return Choice()
    try:
        obj = json.loads(raw[start:end + 1])
    except (ValueError, TypeError):
        return Choice()

    try:
        n = int(obj.get("frame", -1))
    except (TypeError, ValueError):
        n = -1
    try:
        conf = float(obj.get("confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    reason = str(obj.get("reason") or "")[:200]

    if n < 1 or n > len(frames):
        return Choice(index=-1, confidence=conf, reason=reason)
    fr = frames[n - 1]
    return Choice(index=n - 1, at_s=fr.at_s, confidence=conf, reason=reason)


def _post(cfg: Config, messages: list) -> str:
    """One HTTP call. Returns the assistant text, or '' on any failure.

    Deliberately swallows everything: a verifier that raises would take down
    a build it was only ever meant to improve. A network blip, a rate limit,
    a proxy 500 — all of them mean "no opinion", which is the same as not
    being configured, which the build already handles.
    """
    body = json.dumps({
        "model": cfg.model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": 300,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg.endpoint, data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {cfg.key}"})
    try:
        with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]
    except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError):
        return ""


def verify(intent: str, frames: list, must_be_visible=None,
           cfg: Config | None = None) -> Choice:
    """Ask the model which frame is the moment. Never raises.

    Returns a Choice whose `.chose` is True only when the model both picked a
    frame and was confident enough. Everything else — not configured, network
    error, abstention, low confidence — comes back as a Choice that does not
    choose, and the caller leaves the shot exactly where it was.
    """
    if not frames:
        return Choice()
    cfg = cfg or config()
    if not cfg.ok:
        return Choice()
    text = _post(cfg, build_messages(intent, must_be_visible or [], frames))
    if not text:
        return Choice()
    return parse_verdict(text, frames)
