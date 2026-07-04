#!/usr/bin/env python3
"""ProStudio GUI — one video by default, "+ Add Video" for up to 15 jobs.

Each job card: scenes folder, audio, optional clean script, output name,
format (Auto-Rotate / Random / F1..F10), language, niche, keyword-color
toggle. Global: output folder, resolution (4K default), Start Queue, live log.
The GUI writes jobs.json and shells out to prostudio.py (CLI = source of truth).
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


class JobCard(ttk.LabelFrame):
    def __init__(self, master, idx, on_remove):
        super().__init__(master, text=f"Video {idx + 1}", padding=8)
        self.on_remove = on_remove
        self.vars = {
            "scenes": tk.StringVar(), "audio": tk.StringVar(),
            "script": tk.StringVar(), "instructor": tk.StringVar(),
            "name": tk.StringVar(value=f"video_{idx+1:02d}"),
            "format": tk.StringVar(value="Auto-Rotate"),
            "language": tk.StringVar(value="en"),
            "niche": tk.StringVar(value="Movie Essay"),
            "kw": tk.BooleanVar(value=True),
            "text": tk.BooleanVar(value=True),
        }
        r = 0

        def row(label, key, is_dir=False, types=None):
            nonlocal r
            ttk.Label(self, text=label, width=16).grid(row=r, column=0, sticky="w")
            ttk.Entry(self, textvariable=self.vars[key], width=52).grid(
                row=r, column=1, sticky="we", padx=4)
            def browse():
                p = (filedialog.askdirectory() if is_dir else
                     filedialog.askopenfilename(filetypes=types or [("All", "*.*")]))
                if p:
                    self.vars[key].set(p)
            ttk.Button(self, text="…", width=3, command=browse).grid(row=r, column=2)
            r += 1

        row("Scenes folder", "scenes", is_dir=True)
        row("Narration audio", "audio",
            types=[("Audio", "*.mp3 *.wav *.m4a *.aac"), ("All", "*.*")])
        row("Clean script (opt)", "script", types=[("Text", "*.txt"), ("All", "*.*")])
        row("Visual editor (opt)", "instructor",
            types=[("Text", "*.txt *.md"), ("All", "*.*")])

        ttk.Label(self, text="Output name", width=16).grid(row=r, column=0, sticky="w")
        ttk.Entry(self, textvariable=self.vars["name"], width=28).grid(
            row=r, column=1, sticky="w", padx=4)
        r += 1

        opts = ttk.Frame(self)
        opts.grid(row=r, column=0, columnspan=3, sticky="w", pady=(4, 0))
        ttk.Label(opts, text="Format").pack(side="left")
        ttk.Combobox(opts, textvariable=self.vars["format"], values=FMT_CHOICES,
                     width=16, state="readonly").pack(side="left", padx=(2, 10))
        ttk.Label(opts, text="Language").pack(side="left")
        ttk.Combobox(opts, textvariable=self.vars["language"], values=LANGS,
                     width=5, state="readonly").pack(side="left", padx=(2, 10))
        ttk.Label(opts, text="Niche").pack(side="left")
        ttk.Combobox(opts, textvariable=self.vars["niche"],
                     values=list(NICHE_BASE), width=26,
                     state="readonly").pack(side="left", padx=(2, 10))
        ttk.Checkbutton(opts, text="On-screen text",
                        variable=self.vars["text"]).pack(side="left", padx=(0, 8))
        ttk.Checkbutton(opts, text="Keyword colors",
                        variable=self.vars["kw"]).pack(side="left", padx=(0, 10))
        ttk.Button(opts, text="Remove", command=lambda: on_remove(self)
                   ).pack(side="left")

    def job_dict(self, out_dir, resolution):
        v = {k: (var.get() if not isinstance(var, tk.BooleanVar) else var.get())
             for k, var in self.vars.items()}
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
        root.geometry("980x760")
        self.q = queue.Queue()
        self.proc = None
        self.cards = []

        top = ttk.Frame(root, padding=8)
        top.pack(fill="x")
        ttk.Label(top, text="Output folder").pack(side="left")
        self.out_dir = tk.StringVar(value=os.path.join(HERE, "output"))
        ttk.Entry(top, textvariable=self.out_dir, width=48).pack(side="left", padx=4)
        ttk.Button(top, text="…", width=3, command=self._pick_out).pack(side="left")
        ttk.Label(top, text="  Resolution").pack(side="left")
        self.resolution = tk.StringVar(value="4K")
        ttk.Combobox(top, textvariable=self.resolution, width=7,
                     values=list(RESOLUTIONS), state="readonly").pack(side="left")

        mid = ttk.Frame(root)
        mid.pack(fill="both", expand=True, padx=8)
        canvas = tk.Canvas(mid, highlightthickness=0)
        sb = ttk.Scrollbar(mid, orient="vertical", command=canvas.yview)
        self.cards_frame = ttk.Frame(canvas)
        self.cards_frame.bind(
            "<Configure>",
            lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=self.cards_frame, anchor="nw")
        canvas.configure(yscrollcommand=sb.set)
        canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        btns = ttk.Frame(root, padding=8)
        btns.pack(fill="x")
        self.add_btn = ttk.Button(btns, text="+  Add Video", command=self.add_card)
        self.add_btn.pack(side="left")
        self.start_btn = ttk.Button(btns, text="▶  Start Queue", command=self.start)
        self.start_btn.pack(side="left", padx=8)

        prog = ttk.Frame(root, padding=(8, 0))
        prog.pack(fill="x")
        self.status = tk.StringVar(value="idle")
        ttk.Label(prog, textvariable=self.status, width=48).pack(side="left")
        self.pbar = ttk.Progressbar(prog, mode="determinate", maximum=100)
        self.pbar.pack(side="left", fill="x", expand=True, padx=6)
        self.pct = tk.StringVar(value="0%")
        ttk.Label(prog, textvariable=self.pct, width=5).pack(side="left")

        self.log = tk.Text(root, height=12, state="disabled",
                           bg="#101418", fg="#d7e3ee", font=("Consolas", 9))
        self.log.pack(fill="both", expand=False, padx=8, pady=(0, 8))

        self.add_card()          # default: exactly one video
        root.after(120, self._poll)

    def _pick_out(self):
        p = filedialog.askdirectory()
        if p:
            self.out_dir.set(p)

    def add_card(self):
        if len(self.cards) >= MAX_JOBS:
            messagebox.showinfo("ProStudio", f"Maximum {MAX_JOBS} videos per queue.")
            return
        card = JobCard(self.cards_frame, len(self.cards), self.remove_card)
        card.pack(fill="x", pady=4)
        self.cards.append(card)

    def remove_card(self, card):
        if len(self.cards) == 1:
            messagebox.showinfo("ProStudio", "At least one video is required.")
            return
        card.destroy()
        self.cards.remove(card)
        for i, c in enumerate(self.cards):
            c.configure(text=f"Video {i + 1}")

    def _append(self, text):
        import re
        for line in text.splitlines(keepends=True):
            m = re.match(r"\[\s*(\d+)%\]", line)
            if m:
                base, span = self._job_progress_window()
                jobpct = int(m.group(1))
                overall = base + span * jobpct / 100.0
                self.pbar["value"] = overall
                self.pct.set(f"{int(overall)}%")
                self.status.set(line.strip()[:60])
            elif re.match(r"\[\d+/\d+\]\s+(OK|FAILED)", line):
                self._jobs_done = getattr(self, "_jobs_done", 0) + 1
                self.pbar["value"] = self._jobs_done * (100.0 / max(1, getattr(self, "_njobs", 1)))
                self.pct.set(f"{int(self.pbar['value'])}%")
            elif line.startswith("QUEUE DONE"):
                self.pbar["value"] = 100
                self.pct.set("100%")
                self.status.set("finished ✓")
            elif line.startswith("JOB:"):
                self.status.set(line.strip()[:60])
            self.log.configure(state="normal")
            self.log.insert("end", line)
            self.log.see("end")
            self.log.configure(state="disabled")

    def _job_progress_window(self):
        """Each job owns an equal slice of the overall bar (multi-video queue)."""
        n = max(1, getattr(self, "_njobs", 1))
        done = getattr(self, "_jobs_done", 0)
        span = 100.0 / n
        return done * span, span

    def start(self):
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
            json.dump({"resolution": self.resolution.get(), "jobs": jobs}, f, indent=2)
        self._njobs = len(jobs)
        self._jobs_done = 0
        self.pbar["value"] = 0
        self.pct.set("0%")
        self.status.set(f"starting {len(jobs)} video(s) ...")
        self._append(f"\n=== starting queue: {len(jobs)} video(s), "
                     f"{self.resolution.get()} ===\n")

        def worker():
            try:
                self.proc = subprocess.Popen(
                    [sys.executable, os.path.join(HERE, "prostudio.py"),
                     "--queue", qfile],
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
    try:
        ttk.Style().theme_use("clam")
    except Exception:
        pass
    App(root)
    root.mainloop()
