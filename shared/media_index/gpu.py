"""Whether this machine can really run the models on its graphics card.

Written after an install that looked correct and was not. The log read:

    python   3.14.6
    torch    2.13.0+cpu
    ERROR: Could not find a version that satisfies the requirement
           torch==2.5.1 (from versions: none)

and the batch file that produced it had a version number typed into it by
hand. That is the whole fault. A pinned version is a claim about what some
other computer had, and the moment the interpreter is newer than the pin,
the claim is false and the error message blames the network.

So nothing here is pinned and nothing here is assumed. This module asks the
package index what exists for *this* interpreter, and asks the installed
torch what it was actually compiled for. Two questions, both answerable, and
between them they cover every way this has gone wrong:

  1. **Is there a CUDA wheel for this Python at all?**  PyTorch publishes
     CPU wheels for a new Python months before the CUDA ones. Python 3.14
     with `torch 2.13.0+cpu` installed is not a broken machine — it is a
     machine standing in a gap, and the fix is a second interpreter, not a
     retry.

  2. **Was that wheel built for THIS card?**  This is the trap, because
     `torch.cuda.is_available()` says True either way. A Quadro P1000 is
     Pascal, compute 6.1, and recent CUDA wheels ship no `sm_61` kernels.
     Allocation succeeds, `.to("cuda")` succeeds, and the first real
     multiply dies with "no kernel image is available for execution on the
     device" — forty minutes into an index, having reported GPU on line one.

`torch.cuda.get_arch_list()` answers question 2 exactly, for free, before
any work starts. Nothing in this file guesses which architectures a build
supports; it reads the list out of the build.
"""
from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field

# Newest first. Which of these exists for a given Python is not knowable
# from here and is never assumed — the list is only the order to ask in.
CUDA_CHANNELS = ("cu130", "cu129", "cu128", "cu126", "cu124", "cu121", "cu118")
INDEX = "https://download.pytorch.org/whl/{channel}"
# How long to let pip talk to the index before giving up on one channel.
QUERY_TIMEOUT_S = 120


@dataclass
class Report:
    """Every fact a person needs before spending 2.5 GB of download."""
    python: str = ""
    executable: str = ""
    torch: str = ""
    cuda_build: str = ""            # "12.1", or "" for a CPU-only wheel
    device_name: str = ""
    capability: tuple = ()          # (6, 1) for Pascal
    arch_list: list = field(default_factory=list)
    vram_gb: float = 0.0
    free_gb: float = 0.0
    driver_sees_card: bool = False
    computed: bool = False          # a real tensor op ran on the card
    fault: str = ""                 # why it did not

    @property
    def compute(self) -> str:
        return f"{self.capability[0]}.{self.capability[1]}" if self.capability else ""

    @property
    def sm(self) -> str:
        return f"sm_{self.capability[0]}{self.capability[1]}" if self.capability else ""

    @property
    def cpu_only_wheel(self) -> bool:
        return bool(self.torch) and not self.cuda_build

    @property
    def wrong_arch(self) -> bool:
        """The wheel has CUDA, the card is here, and they do not match.

        Kept separate from `computed` because it is knowable in a
        millisecond and `computed` costs a kernel launch — and because it is
        the one failure whose message ("no kernel image") tells a person
        nothing about its cause.
        """
        return bool(self.arch_list and self.sm and self.sm not in self.arch_list)

    @property
    def usable(self) -> bool:
        return self.computed


def probe() -> Report:
    """Measure. Never raises — a machine with no torch is a fact, not an error."""
    import platform                                     # noqa: PLC0415

    rep = Report(python=platform.python_version(), executable=sys.executable)
    try:
        import torch                                    # noqa: PLC0415
    except ImportError:
        rep.fault = "torch install nahi hai"
        return rep

    rep.torch = str(torch.__version__)
    rep.cuda_build = str(getattr(torch.version, "cuda", "") or "")
    try:
        rep.arch_list = list(torch.cuda.get_arch_list())
    except Exception:                                   # CPU wheel, old torch
        rep.arch_list = []

    try:
        rep.driver_sees_card = bool(torch.cuda.is_available())
    except Exception as exc:
        rep.fault = str(exc)
        return rep
    if not rep.driver_sees_card:
        rep.fault = ("CPU-only torch" if rep.cpu_only_wheel
                     else "driver ko koi CUDA card nahi dikha")
        return rep

    try:
        rep.device_name = torch.cuda.get_device_name(0)
        rep.capability = tuple(torch.cuda.get_device_capability(0))
        free, total = torch.cuda.mem_get_info()
        rep.vram_gb, rep.free_gb = total / 1e9, free / 1e9
    except Exception as exc:
        rep.fault = str(exc)
        return rep

    if rep.wrong_arch:
        rep.fault = (f"ye torch {', '.join(rep.arch_list)} ke liye bana hai, "
                     f"aur card {rep.sm} hai")
        return rep

    # The only proof that survives contact with the actual work: allocate,
    # multiply, and read the answer back. `is_available()` has been True on
    # every machine this has ever failed on.
    try:
        a = torch.ones(64, 64, device="cuda")
        got = float((a @ a).sum().item())
        rep.computed = got == 64 * 64 * 64
        if not rep.computed:
            rep.fault = "GPU ne galat jawab diya"
    except Exception as exc:
        rep.fault = f"{type(exc).__name__}: {exc}"
    return rep


def usable_device() -> str:
    """"cuda" only if a real multiply came back right; otherwise "cpu".

    Called by the picture model instead of `torch.cuda.is_available()`. The
    difference between those two lines is a forty-minute index that dies at
    minute forty versus one that runs slower and finishes.
    """
    try:
        return "cuda" if probe().computed else "cpu"
    except Exception:
        return "cpu"


# ---------------------------------------------------------------------------
# what the index actually has for THIS interpreter
# ---------------------------------------------------------------------------

_VERSIONS = re.compile(r"from versions:\s*([^)]*)\)")


def _ask(channel: str) -> list:
    """Every torch version the CUDA channel has a wheel of, for this Python.

    Asked with a version that cannot exist, because pip's refusal names the
    ones that do. `pip index versions` would be tidier and is still marked
    experimental; this trick has worked unchanged for years and its output
    is the same list.

    An empty list is a real answer, not a failure: it means this channel
    publishes nothing your interpreter can install.
    """
    cmd = [sys.executable, "-m", "pip", "install",
           "torch==0.0.0.dev0", "--index-url", INDEX.format(channel=channel)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=QUERY_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return []
    found = _VERSIONS.search((out.stderr or "") + (out.stdout or ""))
    if not found:
        return []
    raw = [v.strip() for v in found.group(1).split(",")]
    return [v for v in raw if v and v.lower() != "none"]


def _key(version: str) -> tuple:
    """Sort 2.9.1 above 2.10.0's string order and below its numeric one."""
    parts = []
    for piece in re.split(r"[.+]", version):
        parts.append(int(piece) if piece.isdigit() else -1)
    return tuple(parts)


@dataclass
class Candidate:
    channel: str
    version: str

    @property
    def index(self) -> str:
        return INDEX.format(channel=self.channel)


def candidates(log=lambda *a: None) -> list:
    """Newest installable torch per CUDA channel, in channel order.

    Every entry is something pip has confirmed it can install here. Nothing
    in this list is a version somebody typed.
    """
    out = []
    for channel in CUDA_CHANNELS:
        log(f"    {channel} ...")
        have = _ask(channel)
        if not have:
            log(f"    {channel}: is Python ke liye kuch nahi")
            continue
        best = sorted(have, key=_key)[-1]
        log(f"    {channel}: {len(have)} version, sabse naya {best}")
        out.append(Candidate(channel=channel, version=best))
    return out


def install(cand: Candidate, log=print) -> bool:
    """Replace torch with the chosen build. True if pip said it worked."""
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade",
           f"torch=={cand.version}", "--index-url", cand.index]
    log(f"    {' '.join(cmd[2:])}")
    try:
        return subprocess.run(cmd).returncode == 0
    except OSError as exc:
        log(f"    pip chala hi nahi: {exc}")
        return False
