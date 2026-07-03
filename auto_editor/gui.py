#!/usr/bin/env python3
"""Auto Editor — simple desktop GUI (same style as the Footage Collector).

Runs auto_editor.py as a subprocess and streams its log into the window,
so the CLI stays the single source of truth.
"""
from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

HERE = os.path.dirname(os.path.abspath(__file__))


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("Auto Editor — footage → Filmora project")
        root.geometry("860x640")
        self.q = queue.Queue()
        self.proc = None

        frm = ttk.Frame(root, padding=10)
        frm.pack(fill="both", expand=True)

        self.vars = {}
        row = 0

        def add_path(label, key, is_dir=False, filetypes=None):
            nonlocal row
            ttk.Label(frm, text=label).grid(row=row, column=0, sticky="w", pady=3)
            var = tk.StringVar()
            self.vars[key] = var
            ttk.Entry(frm, textvariable=var, width=70).grid(row=row, column=1, sticky="we", padx=6)
            def browse():
                if is_dir:
                    p = filedialog.askdirectory()
                else:
                    p = filedialog.askopenfilename(filetypes=filetypes or [("All files", "*.*")])
                if p:
                    var.set(p)
            ttk.Button(frm, text="Browse…", command=browse).grid(row=row, column=2)
            row += 1

        add_path("Footage folder (scene_001…):", "footage", is_dir=True)
        add_path("Narration audio (mp3/wav):", "audio",
                 filetypes=[("Audio", "*.mp3 *.wav *.m4a *.aac"), ("All", "*.*")])
        add_path("Instructor file (.txt):", "instructor",
                 filetypes=[("Text", "*.txt"), ("All", "*.*")])
        add_path("Filmora sample / template:", "template",
                 filetypes=[("Filmora / template", "*.wfpbundle *.wfp *.json"), ("All", "*.*")])
        default_tpl = os.path.join(HERE, "template_data", "filmora_15_6_4.json")
        if os.path.exists(default_tpl):
            self.vars["template"].set(default_tpl)

        ttk.Label(frm, text="Project title:").grid(row=row, column=0, sticky="w", pady=3)
        self.vars["title"] = tk.StringVar(value="MyVideo")
        ttk.Entry(frm, textvariable=self.vars["title"], width=40).grid(
            row=row, column=1, sticky="w", padx=6)
        row += 1

        ttk.Label(frm, text="Sync mode:").grid(row=row, column=0, sticky="w", pady=3)
        self.vars["align"] = tk.StringVar(value="whisper")
        box = ttk.Frame(frm)
        box.grid(row=row, column=1, sticky="w", padx=6)
        for val, txt in (("whisper", "Whisper (best)"), ("weighted", "By word count"),
                         ("fixed", "Fixed (no audio)")):
            ttk.Radiobutton(box, text=txt, value=val,
                            variable=self.vars["align"]).pack(side="left", padx=4)
        row += 1

        ttk.Label(frm, text="Transitions:").grid(row=row, column=0, sticky="w", pady=3)
        opt = ttk.Frame(frm)
        opt.grid(row=row, column=1, sticky="w", padx=6)
        self.vars["transition"] = tk.StringVar(value="dissolve")
        ttk.Entry(opt, textvariable=self.vars["transition"], width=14).pack(side="left")
        ttk.Label(opt, text="  scene end:").pack(side="left")
        self.vars["scene_transition"] = tk.StringVar(value="fade_black")
        ttk.Entry(opt, textvariable=self.vars["scene_transition"], width=14).pack(side="left")
        ttk.Label(opt, text="  image animation:").pack(side="left")
        self.vars["image_animation"] = tk.StringVar(value="zoom out 2")
        ttk.Entry(opt, textvariable=self.vars["image_animation"], width=18).pack(side="left")
        row += 1

        self.vars["no_text"] = tk.BooleanVar(value=False)
        ttk.Checkbutton(frm, text="Skip on-screen texts",
                        variable=self.vars["no_text"]).grid(row=row, column=1, sticky="w", padx=6)
        row += 1

        add_path("Output .wfpbundle:", "out",
                 filetypes=[("Filmora bundle", "*.wfpbundle"), ("All", "*.*")])

        btns = ttk.Frame(frm)
        btns.grid(row=row, column=0, columnspan=3, pady=8)
        self.dry_btn = ttk.Button(btns, text="Preview plan (dry run)",
                                  command=lambda: self.run(dry=True))
        self.dry_btn.pack(side="left", padx=6)
        self.go_btn = ttk.Button(btns, text="Generate Filmora project",
                                 command=lambda: self.run(dry=False))
        self.go_btn.pack(side="left", padx=6)
        row += 1

        self.log = tk.Text(frm, height=20, state="disabled",
                           bg="#101418", fg="#d7e3ee", font=("Consolas", 9))
        self.log.grid(row=row, column=0, columnspan=3, sticky="nsew", pady=6)
        frm.rowconfigure(row, weight=1)
        frm.columnconfigure(1, weight=1)

        root.after(100, self.poll)

    def append(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text)
        self.log.see("end")
        self.log.configure(state="disabled")

    def run(self, dry: bool):
        if self.proc and self.proc.poll() is None:
            messagebox.showinfo("Auto Editor", "Already running.")
            return
        v = {k: (var.get() if not isinstance(var, tk.BooleanVar) else var.get())
             for k, var in self.vars.items()}
        if not v["footage"]:
            messagebox.showerror("Auto Editor", "Choose the footage folder first.")
            return
        out = v["out"] or os.path.join(v["footage"], v["title"] + ".wfpbundle")
        cmd = [sys.executable, os.path.join(HERE, "auto_editor.py"),
               "--footage", v["footage"], "--title", v["title"] or "MyVideo",
               "--out", out, "--align", v["align"],
               "--transition", v["transition"] or "dissolve",
               "--scene-transition", v["scene_transition"] or "fade_black",
               "--image-animation", v["image_animation"] or "zoom out 2"]
        if v["audio"]:
            cmd += ["--audio", v["audio"]]
        if v["instructor"]:
            cmd += ["--instructor", v["instructor"]]
        if v["template"]:
            cmd += ["--template", v["template"]]
        if v["no_text"]:
            cmd += ["--no-text"]
        if dry:
            cmd += ["--dry-run"]
        self.append("\n> " + " ".join(cmd) + "\n\n")

        def worker():
            try:
                self.proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace", cwd=HERE)
                for line in self.proc.stdout:
                    self.q.put(line)
                self.proc.wait()
                self.q.put(f"\n[exit code {self.proc.returncode}]\n")
            except Exception as exc:
                self.q.put(f"ERROR: {exc}\n")

        threading.Thread(target=worker, daemon=True).start()

    def poll(self):
        try:
            while True:
                self.append(self.q.get_nowait())
        except queue.Empty:
            pass
        self.root.after(100, self.poll)


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()
