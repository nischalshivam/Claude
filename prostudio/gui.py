#!/usr/bin/env python3
"""ProStudio GUI — modern, responsive, fully scrollable.

One video by default, "+ Add Video" for up to 15 jobs (overnight bulk).
Everything above the action bar scrolls, so it works on small and large
screens and has room for the growing option set. The GUI writes jobs.json
and shells out to prostudio.py / review_server.py (the CLI is the source of
truth).
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from engine import RESOLUTIONS  # noqa: E402
from engine.formats import FORMATS, NICHE_BASE  # noqa: E402

MAX_JOBS = 15
LANGS = ["en", "fr", "de", "es", "it", "pt", "pl", "cs", "hu", "nl"]
FMT_CHOICES = ["Auto-Rotate", "Random"] + list(FORMATS)

# ---- modern palette -------------------------------------------------------
BG = "#0f1420"        # window ground
PANEL = "#171d2b"     # cards / sections
FIELD = "#1f2838"     # inputs
LINE = "#2a3446"      # hairlines
FG = "#e7edf6"        # text
MUT = "#94a3b8"       # muted text
ACCENT = "#4f8cff"    # primary (blue)
GO = "#22c55e"        # start (green)
GO_INK = "#04210f"


def _apply_theme(root: tk.Tk):
    root.configure(bg=BG)
    st = ttk.Style(root)
    try:
        st.theme_use("clam")
    except Exception:
        pass
    st.configure(".", background=BG, foreground=FG, fieldbackground=FIELD,
                 bordercolor=LINE, focuscolor=ACCENT, font=("Segoe UI", 10))
    st.configure("TFrame", background=BG)
    st.configure("Panel.TFrame", background=PANEL)
    st.configure("TLabel", background=BG, foreground=FG)
    st.configure("Panel.TLabel", background=PANEL, foreground=FG)
    st.configure("Muted.TLabel", background=BG, foreground=MUT)
    st.configure("PanelMuted.TLabel", background=PANEL, foreground=MUT)
    st.configure("Title.TLabel", background=BG, foreground=FG,
                 font=("Segoe UI Semibold", 16))
    st.configure("Sub.TLabel", background=BG, foreground=MUT,
                 font=("Segoe UI", 9))
    st.configure("Head.TLabel", background=PANEL, foreground=ACCENT,
                 font=("Segoe UI Semibold", 11))
    st.configure("TEntry", fieldbackground=FIELD, foreground=FG,
                 insertcolor=FG, bordercolor=LINE, padding=5)
    st.map("TEntry", bordercolor=[("focus", ACCENT)])
    st.configure("TCombobox", fieldbackground=FIELD, background=FIELD,
                 foreground=FG, arrowcolor=FG, bordercolor=LINE, padding=4)
    st.map("TCombobox", fieldbackground=[("readonly", FIELD)],
           foreground=[("readonly", FG)])
    root.option_add("*TCombobox*Listbox.background", FIELD)
    root.option_add("*TCombobox*Listbox.foreground", FG)
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT)
    st.configure("TButton", background=FIELD, foreground=FG, bordercolor=LINE,
                 padding=(10, 6), relief="flat")
    st.map("TButton", background=[("active", LINE)],
           bordercolor=[("active", ACCENT)])
    st.configure("Accent.TButton", background=ACCENT, foreground="#ffffff",
                 padding=(12, 7))
    st.map("Accent.TButton", background=[("active", "#3f74d6")])
    st.configure("Go.TButton", background=GO, foreground=GO_INK,
                 padding=(14, 8), font=("Segoe UI Semibold", 10))
    st.map("Go.TButton", background=[("active", "#1eb257")])
    st.configure("TCheckbutton", background=PANEL, foreground=FG)
    st.map("TCheckbutton", background=[("active", PANEL)])
    st.configure("Card.TLabelframe", background=PANEL, bordercolor=LINE,
                 relief="solid", borderwidth=1)
    st.configure("Card.TLabelframe.Label", background=PANEL, foreground=ACCENT,
                 font=("Segoe UI Semibold", 10))
    st.configure("Horizontal.TProgressbar", background=ACCENT,
                 troughcolor=FIELD, bordercolor=LINE, thickness=8)


class JobCard(ttk.LabelFrame):
    def __init__(self, master, idx, on_remove):
        super().__init__(master, text=f"  Video {idx + 1}  ", padding=12,
                         style="Card.TLabelframe")
        self.on_remove = on_remove
        self.vars = {
            "scenes": tk.StringVar(), "audio": tk.StringVar(),
            "script": tk.StringVar(), "instructor": tk.StringVar(),
            "name": tk.StringVar(value=f"video_{idx+1:02d}"),
            "format": tk.StringVar(value="Auto-Rotate"),
            "language": tk.StringVar(value="en"),
            "niche": tk.StringVar(value="Movie Essay"),
            "kw": tk.BooleanVar(value=True),
            "text": tk.BooleanVar(value=False),   # on-screen text OFF by default
        }
        self.columnconfigure(1, weight=1)
        r = 0

        def row(label, key, is_dir=False, types=None):
            nonlocal r
            ttk.Label(self, text=label, width=17, style="Panel.TLabel").grid(
                row=r, column=0, sticky="w", pady=3)
            ttk.Entry(self, textvariable=self.vars[key]).grid(
                row=r, column=1, sticky="we", padx=6, pady=3)

            def browse():
                p = (filedialog.askdirectory() if is_dir else
                     filedialog.askopenfilename(filetypes=types or [("All", "*.*")]))
                if p:
                    self.vars[key].set(p)
            ttk.Button(self, text="Browse", width=8, command=browse).grid(
                row=r, column=2, pady=3)
            r += 1

        row("Scenes folder", "scenes", is_dir=True)
        row("Narration audio", "audio",
            types=[("Audio", "*.mp3 *.wav *.m4a *.aac"), ("All", "*.*")])
        row("Clean script (opt)", "script",
            types=[("Text", "*.txt"), ("All", "*.*")])
        row("Visual editor (opt)", "instructor",
            types=[("Text", "*.txt *.md"), ("All", "*.*")])

        ttk.Label(self, text="Output name", width=17, style="Panel.TLabel").grid(
            row=r, column=0, sticky="w", pady=3)
        ttk.Entry(self, textvariable=self.vars["name"]).grid(
            row=r, column=1, sticky="w", padx=6, pady=3)
        r += 1

        opts = ttk.Frame(self, style="Panel.TFrame")
        opts.grid(row=r, column=0, columnspan=3, sticky="we", pady=(8, 0))
        for lbl, key, vals, w in (
                ("Format", "format", FMT_CHOICES, 15),
                ("Language", "language", LANGS, 5),
                ("Niche", "niche", list(NICHE_BASE), 22)):
            ttk.Label(opts, text=lbl, style="PanelMuted.TLabel").pack(side="left")
            ttk.Combobox(opts, textvariable=self.vars[key], values=vals,
                         width=w, state="readonly").pack(side="left",
                                                          padx=(4, 14))
        r += 1
        toggles = ttk.Frame(self, style="Panel.TFrame")
        toggles.grid(row=r, column=0, columnspan=3, sticky="we", pady=(8, 0))
        ttk.Checkbutton(toggles, text="On-screen text (optional)",
                        variable=self.vars["text"]).pack(side="left", padx=(0, 14))
        ttk.Checkbutton(toggles, text="Keyword colors",
                        variable=self.vars["kw"]).pack(side="left")
        ttk.Button(toggles, text="Remove", width=9,
                   command=lambda: on_remove(self)).pack(side="right")

    def job_dict(self, out_dir, resolution):
        v = {k: var.get() for k, var in self.vars.items()}
        fmt = v["format"]
        fmt = ("auto" if fmt == "Auto-Rotate" else
               "random" if fmt == "Random" else fmt)
        return {
            "scenes": v["scenes"], "audio": v["audio"], "script": v["script"],
            "instructor": v["instructor"],
            "out": os.path.join(out_dir, v["name"] + ".mp4"),
            "format": fmt, "language": v["language"], "niche": v["niche"],
            "keyword_colors": bool(v["kw"]), "text": bool(v["text"]),
            "resolution": resolution,
        }


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("ProStudio — automatic documentary editor")
        root.geometry("1000x820")
        root.minsize(720, 560)
        _apply_theme(root)
        self.q = queue.Queue()
        self.proc = None
        self.cards = []

        # ---- header (fixed) ----
        header = ttk.Frame(root, padding=(16, 12, 16, 6))
        header.pack(fill="x")
        ttk.Label(header, text="ProStudio", style="Title.TLabel").pack(side="left")
        ttk.Label(header, text="  scene folders + narration → finished 4K video",
                  style="Sub.TLabel").pack(side="left", padx=(2, 0), pady=(8, 0))

        # ---- scrollable body (everything above the action bar) ----
        body_wrap = ttk.Frame(root)
        body_wrap.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(body_wrap, bg=BG, highlightthickness=0)
        sb = ttk.Scrollbar(body_wrap, orient="vertical",
                           command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.body = ttk.Frame(self.canvas, padding=(16, 6))
        self._win = self.canvas.create_window((0, 0), window=self.body,
                                              anchor="nw")
        self.body.bind("<Configure>", lambda e: self.canvas.configure(
            scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>",
                         lambda e: self.canvas.itemconfig(self._win, width=e.width))
        for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            self.canvas.bind_all(seq, self._on_wheel)

        # global settings section
        gs = ttk.Frame(self.body, style="Panel.TFrame", padding=12)
        gs.pack(fill="x", pady=(0, 8))
        gs.columnconfigure(1, weight=1)
        ttk.Label(gs, text="Output folder", width=13,
                  style="Panel.TLabel").grid(row=0, column=0, sticky="w")
        self.out_dir = tk.StringVar(value=os.path.join(HERE, "output"))
        ttk.Entry(gs, textvariable=self.out_dir).grid(row=0, column=1,
                                                      sticky="we", padx=6)
        ttk.Button(gs, text="Browse", width=8, command=self._pick_out).grid(
            row=0, column=2)
        ttk.Label(gs, text="Resolution", style="PanelMuted.TLabel").grid(
            row=0, column=3, padx=(14, 4))
        self.resolution = tk.StringVar(value="4K")
        ttk.Combobox(gs, textvariable=self.resolution, width=7,
                     values=list(RESOLUTIONS), state="readonly").grid(
            row=0, column=4)

        self.cards_frame = ttk.Frame(self.body)
        self.cards_frame.pack(fill="x")

        # ---- action bar (fixed) ----
        bar = ttk.Frame(root, padding=(16, 8))
        bar.pack(fill="x")
        ttk.Button(bar, text="+  Add Video", command=self.add_card).pack(
            side="left")
        ttk.Button(bar, text="🔍  Preview & Edit (Video 1)", style="Accent.TButton",
                   command=self.review).pack(side="left", padx=8)
        ttk.Button(bar, text="▶  Start Queue", style="Go.TButton",
                   command=self.start).pack(side="left", padx=4)
        ttk.Button(bar, text="⏸  Stop", command=self.stop).pack(
            side="left", padx=4)
        ttk.Button(bar, text="⏵  Resume",
                   command=lambda: self.start(resume=True)).pack(side="left")

        prog = ttk.Frame(root, padding=(16, 0))
        prog.pack(fill="x")
        self.status = tk.StringVar(value="idle")
        ttk.Label(prog, textvariable=self.status, width=42,
                  style="Muted.TLabel").pack(side="left")
        self.pbar = ttk.Progressbar(prog, mode="determinate", maximum=100)
        self.pbar.pack(side="left", fill="x", expand=True, padx=8)
        self.pct = tk.StringVar(value="0%")
        ttk.Label(prog, textvariable=self.pct, width=5,
                  style="Muted.TLabel").pack(side="left")

        self.log = tk.Text(root, height=10, state="disabled", bg="#0b0f17",
                           fg="#cdd8e6", insertbackground=FG, relief="flat",
                           font=("Consolas", 9), padx=10, pady=8)
        self.log.pack(fill="both", expand=False, padx=16, pady=(6, 12))

        self.add_card()          # default: exactly one video
        root.after(120, self._poll)

    def _on_wheel(self, e):
        if getattr(e, "num", None) == 4:
            self.canvas.yview_scroll(-3, "units")
        elif getattr(e, "num", None) == 5:
            self.canvas.yview_scroll(3, "units")
        else:
            self.canvas.yview_scroll(int(-e.delta / 40), "units")

    def _pick_out(self):
        p = filedialog.askdirectory()
        if p:
            self.out_dir.set(p)

    def add_card(self):
        if len(self.cards) >= MAX_JOBS:
            messagebox.showinfo("ProStudio", f"Maximum {MAX_JOBS} videos per queue.")
            return
        card = JobCard(self.cards_frame, len(self.cards), self.remove_card)
        card.pack(fill="x", pady=5)
        self.cards.append(card)

    def remove_card(self, card):
        if len(self.cards) == 1:
            messagebox.showinfo("ProStudio", "At least one video is required.")
            return
        card.destroy()
        self.cards.remove(card)
        for i, c in enumerate(self.cards):
            c.configure(text=f"  Video {i + 1}  ")

    def _append(self, text):
        import re
        for line in text.splitlines(keepends=True):
            m = re.match(r"\[\s*(\d+)%\]", line)
            if m:
                base, span = self._job_progress_window()
                overall = base + span * int(m.group(1)) / 100.0
                self.pbar["value"] = overall
                self.pct.set(f"{int(overall)}%")
                self.status.set(line.strip()[:56])
            elif re.match(r"\[\d+/\d+\]\s+(OK|FAILED)", line):
                self._jobs_done = getattr(self, "_jobs_done", 0) + 1
                self.pbar["value"] = self._jobs_done * (
                    100.0 / max(1, getattr(self, "_njobs", 1)))
                self.pct.set(f"{int(self.pbar['value'])}%")
            elif line.startswith("QUEUE DONE"):
                self.pbar["value"] = 100
                self.pct.set("100%")
                self.status.set("finished ✓")
            elif line.startswith(("JOB:", "Review page:")):
                self.status.set(line.strip()[:56])
            self.log.configure(state="normal")
            self.log.insert("end", line)
            self.log.see("end")
            self.log.configure(state="disabled")

    def _job_progress_window(self):
        n = max(1, getattr(self, "_njobs", 1))
        done = getattr(self, "_jobs_done", 0)
        span = 100.0 / n
        return done * span, span

    def review(self):
        card = self.cards[0]
        j = card.job_dict(self.out_dir.get(), self.resolution.get())
        if not (j["scenes"] and j["audio"]):
            messagebox.showerror("ProStudio",
                                 "Video 1: scenes folder and audio required.")
            return
        os.makedirs(self.out_dir.get(), exist_ok=True)
        qfile = os.path.join(self.out_dir.get(), "review_job.json")
        with open(qfile, "w", encoding="utf-8") as f:
            json.dump({"resolution": self.resolution.get(), "jobs": [j]}, f,
                      indent=2)
        self.status.set("preparing review page (draft render) ...")
        self._append("\n=== opening browser review for Video 1 ===\n"
                     "   (a fast draft is rendered first; the page opens automatically)\n")

        def worker():
            try:
                proc = subprocess.Popen(
                    [sys.executable, "-u", os.path.join(HERE, "review_server.py"),
                     "--queue", qfile],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace", cwd=HERE)
                self._review_proc = proc
                for line in proc.stdout:
                    self.q.put(line)
            except Exception as exc:
                self.q.put(f"REVIEW ERROR: {exc}\n")

        threading.Thread(target=worker, daemon=True).start()

    def stop(self):
        """Stop the running queue. Finished videos and already-rendered shots
        are kept on disk, so Resume continues from where it stopped."""
        p = self.proc
        stopped = False
        if p and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
            stopped = True
        rp = getattr(self, "_review_proc", None)
        if rp and rp.poll() is None:
            try:
                rp.terminate()
            except Exception:
                pass
            stopped = True
        if stopped:
            self.status.set("stopped — click Resume to continue")
            self._append("\n[stopped by user — click ⏵ Resume to continue "
                         "from where it stopped]\n")
        else:
            self.status.set("nothing is running")

    def start(self, resume=False):
        if self.proc and self.proc.poll() is None:
            messagebox.showinfo("ProStudio", "Queue already running.")
            return
        jobs = []
        for i, c in enumerate(self.cards):
            j = c.job_dict(self.out_dir.get(), self.resolution.get())
            if not (j["scenes"] and j["audio"]):
                messagebox.showerror("ProStudio",
                                     f"Video {i + 1}: scenes folder and audio required.")
                return
            jobs.append(j)
        os.makedirs(self.out_dir.get(), exist_ok=True)
        qfile = os.path.join(self.out_dir.get(), "jobs.json")
        with open(qfile, "w", encoding="utf-8") as f:
            json.dump({"resolution": self.resolution.get(), "jobs": jobs}, f,
                      indent=2)
        self._njobs = len(jobs)
        self._jobs_done = 0
        self.pbar["value"] = 0
        self.pct.set("0%")
        verb = "resuming" if resume else "starting"
        self.status.set(f"{verb} {len(jobs)} video(s) ...")
        self._append(f"\n=== {verb} queue: {len(jobs)} video(s), "
                     f"{self.resolution.get()} ===\n")
        cmd = [sys.executable, "-u", os.path.join(HERE, "prostudio.py"),
               "--queue", qfile]
        if resume:
            cmd.append("--resume")

        def worker():
            try:
                self.proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace", cwd=HERE)
                for line in self.proc.stdout:
                    self.q.put(line)
                self.proc.wait()
                self.q.put(f"\n[queue finished, exit {self.proc.returncode}]\n")
            except Exception as exc:
                self.q.put(f"ERROR: {exc}\n")

        threading.Thread(target=worker, daemon=True).start()

    def _poll(self):
        try:
            while True:
                self._append(self.q.get_nowait())
        except queue.Empty:
            pass
        self.root.after(120, self._poll)


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()
