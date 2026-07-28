/* The Movie Editor, wired to the tool.
 *
 * The design decides how this looks; this decides what is true. Every number
 * on screen is read from the same files the menu already writes — nothing
 * here keeps its own copy of anything, so the browser and the terminal can
 * be open at once and neither can be wrong about the other.
 *
 * The style helpers (navStyle, chipStyle, segStyle …) are ported from the
 * design's own script, unchanged in what they produce. They live here rather
 * than being evaluated out of the design file because a design is a drawing:
 * it should never be able to decide what the tool does.
 */
(function () {
  "use strict";

  var state = {
    nav: "Library",
    theme: localStorage.getItem("me.theme") || "light",
    collapsed: localStorage.getItem("me.collapsed") === "1",
    filter: "all",
    loading: true,
    failed: "",
    library: null,

    // --- New Video ---------------------------------------------------
    form: load("me.form", {
      title: "", script: "", audio: "", name: "", out: "",
      preset: "auto", quality: "1080", pace: "normal", clip: 4.0,
    }),
    script: null,           // what the chosen script says about itself
    scriptError: "",
    audio: null,
    srcOpen: false,
    task: null,             // the check or build that is running / just ran
    panelDismissed: false,

    picker: null,           // {kind, target, path, data}
  };

  var screens = "";
  var where = null;
  var timer = null;

  function load(key, fallback) {
    try {
      var kept = JSON.parse(localStorage.getItem(key) || "null");
      return kept ? Object.assign({}, fallback, kept) : fallback;
    } catch (e) { return fallback; }
  }

  function setState(patch) {
    Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    draw();
  }

  // A text field holds its own value; redrawing on every keystroke would
  // only take the caret away from whoever is typing. Remembered, not drawn.
  function setQuiet(patch) {
    Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    remember();
  }

  function remember() {
    try { localStorage.setItem("me.form", JSON.stringify(state.form)); }
    catch (e) { /* a full or private-mode store is not worth an error */ }
  }

  /* ------------------------------------------------------------- fetching */

  function body(r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
      return data;
    });
  }

  function get(url) { return fetch(url).then(body); }

  function post(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(body);
  }

  function loadLibrary() {
    setState({ loading: true, failed: "" });
    return get("/api/titles").then(function (data) {
      var form = state.form;
      // Pick the obvious title rather than making someone choose between one
      // option and nothing.
      if (!form.title && (data.titles || []).length) {
        form.title = data.titles[0].name;
      }
      setState({ library: data, loading: false });
    }).catch(function (err) {
      setState({ loading: false, failed: String(err.message || err) });
    });
  }

  /* ------------------------------------------------------- what runs, runs */

  function watch(task) {
    setState({ task: task, panelDismissed: false });
    if (timer) clearInterval(timer);
    if (task.status !== "running") return;
    timer = setInterval(function () {
      get("/api/task?id=" + encodeURIComponent(task.id)).then(function (now) {
        setState({ task: now });
        if (now.status !== "running") {
          clearInterval(timer);
          timer = null;
        }
      }).catch(function () {
        clearInterval(timer);
        timer = null;                   // the server went away; stop asking
      });
    }, 1000);
  }

  function spec() {
    var f = state.form;
    var chosen = titleNamed(f.title);
    return {
      name: f.name || "video",
      script: f.script,
      audio: f.audio,
      out: f.out,
      db: chosen ? chosen.db : "",
      clip_seconds: parseFloat(f.clip) || 4.0,
      pace: f.pace,
      quality: f.quality,
      preset: f.preset,
      title: f.title,
    };
  }

  function missingField() {
    var f = state.form;
    if (!f.script) return "Script chuno";
    if (!f.out) return "Output folder do";
    if (state.scriptError) return "Script padhi nahi ja rahi";
    return "";
  }

  function run(url, extra) {
    var why = missingField();
    if (why) { setState({ task: { status: "failed", error: why, kind: "check", lines: [] } }); return; }
    post(url, Object.assign(spec(), extra || {}))
      .then(watch)
      .catch(function (err) {
        setState({ task: { status: "failed", kind: "check", lines: [],
                           error: String(err.message || err) } });
      });
  }

  /* -------------------------------------------------- styles, from design */

  function navStyle(name) {
    var active = state.nav === name, c = state.collapsed;
    return "display:flex; align-items:center; gap:10px; border-radius:8px; cursor:pointer; user-select:none; font-size:13px; white-space:nowrap; overflow:hidden; transition:background .12s ease, color .12s ease; "
      + (c ? "padding:9px 0; justify-content:center; " : "padding:7px 10px; ")
      + (active
        ? "background:var(--accent-soft); color:var(--accent); font-weight:600;"
        : "color:var(--muted); font-weight:450;");
  }

  function chipStyle(name) {
    var active = state.filter === name;
    return "display:flex; align-items:center; gap:6px; padding:7px 14px; border-radius:999px; font-size:12.5px; cursor:pointer; user-select:none; transition:all .13s ease; "
      + (active
        ? "background:var(--accent); color:var(--on-accent); font-weight:550;"
        : "background:var(--raised); color:var(--muted); font-weight:500;");
  }

  function segStyle(name) {
    var active = state.theme === name;
    return "flex:1; display:flex; align-items:center; justify-content:center; gap:6px; padding:6px 0; border-radius:8px; font-size:12px; cursor:pointer; user-select:none; transition:all .15s ease; "
      + (active
        ? "background:var(--surface); color:var(--text); font-weight:600; box-shadow:var(--shadow-sm);"
        : "color:var(--muted); font-weight:500;");
  }

  function seg2(on) {
    return "flex:1; text-align:center; padding:7px 14px; border-radius:8px; font-size:12.5px; cursor:pointer; user-select:none; white-space:nowrap; transition:all .14s ease; "
      + (on ? "background:var(--surface); color:var(--text); font-weight:600; box-shadow:var(--shadow-sm);"
            : "color:var(--muted); font-weight:500;");
  }

  function presetCard(on) {
    return "flex:1; padding:14px 15px; border-radius:12px; cursor:pointer; user-select:none; transition:all .15s ease; border:1.5px solid "
      + (on ? "var(--accent); background:var(--accent-soft); box-shadow:var(--shadow-sm);"
            : "var(--border); background:var(--surface);");
  }

  var SECONDARY = "background:var(--surface); border:1px solid var(--border-strong); color:var(--text); font-size:13px; font-weight:550; padding:9px 14px; border-radius:9px; cursor:pointer; white-space:nowrap; transition:background .15s ease;";

  // The four status colours the design defines. A tone is decided once, so
  // the badge, its dot and the tile always agree.
  var TONES = { ready: "ok", partial: "busy", attention: "warn", empty: "muted" };

  function badgeStyle(tone) {
    var base = "display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:550; padding:4px 10px; border-radius:999px; white-space:nowrap; ";
    if (tone === "muted") {
      return base + "color:var(--muted); background:var(--raised); border:1px solid var(--border);";
    }
    return base + "color:var(--" + tone + "); background:var(--" + tone
      + "-soft); border:1px solid var(--" + tone + "-line);";
  }

  function dot(tone) {
    return "width:6px; height:6px; flex:0 0 6px; border-radius:50%; background:"
      + (tone === "muted" ? "var(--muted)" : "var(--" + tone + ")") + ";";
  }

  function initialsOf(name) {
    var words = String(name || "?").split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  /* ------------------------------------------------------------ view model */

  function allTitles() { return (state.library || {}).titles || []; }

  function titleNamed(name) {
    return allTitles().filter(function (t) { return t.name === name; })[0] || null;
  }

  function titleView(t) {
    var tone = TONES[t.status] || "muted";
    var counted = t.kind === "movie"
      ? (t.size === "—" ? "not indexed" : t.size)
      : (t.files + " episode" + (t.files === 1 ? "" : "s")
         + (t.size === "—" ? "" : " · " + t.size));
    return {
      name: t.name, kind: t.kind, detail: t.detail,
      media_root: t.media_root || "—",
      counted: counted,
      files: t.files, indexed: t.indexed, missing: t.missing,
      percent: t.files ? Math.round(t.indexed * 100 / t.files) : 0,
      partial: t.indexed > 0 && t.indexed < t.files,
      hasNoSubs: t.no_subs.length > 0,
      noSubsList: t.no_subs.join(", "),
      hasMissing: t.missing > 0,
      initials: initialsOf(t.name),
      initialsStyle: "width:40px; height:40px; flex:0 0 40px; border-radius:11px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:650; letter-spacing:-0.02em; "
        + (tone === "muted"
          ? "background:var(--raised); color:var(--muted);"
          : "background:var(--" + tone + "-soft); color:var(--" + tone + ");"),
      badgeStyle: badgeStyle(tone),
      dotStyle: "width:5px; height:5px; border-radius:50%; background:"
        + (tone === "muted" ? "var(--muted)" : "var(--" + tone + ")") + ";",
    };
  }

  function visible(rows) {
    var f = state.filter;
    return rows.filter(function (t) {
      if (f === "series") return t.kind === "series";
      if (f === "movie") return t.kind === "movie";
      if (f === "issue") return t.status !== "ready";
      return true;
    });
  }

  function baseName(path) {
    return String(path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  }

  function clock(seconds) {
    var s = Math.max(0, Math.round(seconds || 0));
    var m = Math.floor(s / 60);
    return m ? m + "m " + ("0" + (s % 60)).slice(-2) + "s" : s + "s";
  }

  /* ------------------------------------------------------------ the picker */

  function openPicker(kind, target) {
    // Where this field already points, then wherever the picker was last
    // left. Somebody choosing a script and then an output folder is almost
    // always working in the same corner of one drive, and starting them at
    // their home folder every time makes them walk back each time.
    var at = state.form[target] || localStorage.getItem("me.browsedAt") || "";
    setState({ picker: { kind: kind, target: target, path: at, data: null } });
    walk(at);
  }

  // The tail of a long path, which is the end that says where you are. An
  // ellipsis on the left is the honest way to shorten it; CSS `direction:rtl`
  // looks right until a path starting with a slash renders as "root/".
  function tail(path, keep) {
    var text = String(path || "");
    return text.length <= keep ? text : "…" + text.slice(-(keep - 1));
  }

  function walk(path) {
    get("/api/browse?kind=" + encodeURIComponent(state.picker.kind)
        + "&path=" + encodeURIComponent(path || ""))
      .then(function (data) {
        if (!state.picker) return;      // closed while the answer was coming
        state.picker.path = data.path;
        state.picker.data = data;
        try { localStorage.setItem("me.browsedAt", data.path); }
        catch (e) { /* a full store must not stop the picker working */ }
        draw();
      })
      .catch(function (err) {
        if (!state.picker) return;
        state.picker.data = { error: String(err.message || err),
                              folders: [], files: [], drives: [] };
        draw();
      });
  }

  function choose(path) {
    var target = state.picker.target;
    state.form[target] = path;
    setState({ picker: null });
    remember();
    if (target === "script") readScript(path);
    if (target === "audio") readAudio(path);
  }

  function readScript(path) {
    setState({ script: null, scriptError: "" });
    get("/api/script?path=" + encodeURIComponent(path))
      .then(function (data) {
        // A name for the video, if there is not one already: the file's own
        // is a better first guess than an empty box.
        if (!state.form.name) {
          state.form.name = baseName(path).replace(/\.json$/i, "");
          remember();
        }
        setState({ script: data });
      })
      .catch(function (err) {
        setState({ scriptError: String(err.message || err) });
      });
  }

  function readAudio(path) {
    setState({ audio: null });
    get("/api/audio?path=" + encodeURIComponent(path))
      .then(function (data) { setState({ audio: data }); })
      .catch(function () { setState({ audio: null }); });
  }

  function pickerScope() {
    var p = state.picker;
    if (!p) {
      return { pickerOpen: false, pickerRows: [], pickerDrives: [],
               pickerPath: "", pickerShown: "", pickerTitle: "",
               pickerError: "",
               pickerEmpty: false, pickerEmptyWhy: "", pickerHint: "",
               pickingFolder: false, hasDrives: false,
               closePicker: function () {}, swallow: function () {},
               pickerUpGo: function () {}, useThisFolder: function () {} };
    }
    var d = p.data || { folders: [], files: [], drives: [] };
    var rows = [];
    (d.folders || []).forEach(function (f) {
      rows.push({ name: f.name, meta: "", icon: "▸",
        iconStyle: "width:16px; color:var(--faint); font-size:11px;",
        go: function () { walk(f.path); } });
    });
    (d.files || []).forEach(function (f) {
      rows.push({ name: f.name, icon: "•",
        meta: f.size > 1024 * 1024
          ? (f.size / 1024 / 1024).toFixed(1) + " MB"
          : Math.max(1, Math.round(f.size / 1024)) + " KB",
        iconStyle: "width:16px; color:var(--accent); font-size:11px;",
        go: function () { choose(f.path); } });
    });
    var folderMode = p.kind === "folder";
    return {
      pickerOpen: true,
      pickerTitle: { script: "Script chuno", audio: "Voiceover chuno",
                     folder: "Folder chuno" }[p.kind] || "Chuno",
      pickerPath: p.path || "",
      pickerShown: tail(p.path || "", 62),
      pickerRows: rows,
      pickerDrives: (d.drives || []).map(function (dr) {
        return { name: dr.name, go: function () { walk(dr.path); } };
      }),
      hasDrives: (d.drives || []).length > 1,
      pickerError: d.error || "",
      pickerEmpty: !d.error && rows.length === 0 && !!p.data,
      pickerEmptyWhy: folderMode ? "Is folder me aur folder nahi hai."
        : "Is folder me is tarah ki koi file nahi hai.",
      pickerHint: folderMode
        ? "Folder me jao, phir neeche wala button dabao."
        : "File pe click karo.",
      pickingFolder: folderMode,
      upBtn: "font-size:12px; font-weight:550; color:var(--muted); background:var(--raised); padding:7px 12px; border-radius:8px; cursor:pointer; white-space:nowrap;",
      pickerUpGo: function () { if (d.up) walk(d.up); },
      useThisFolder: function () { choose(p.path); },
      closePicker: function () { setState({ picker: null }); },
      swallow: function (ev) { ev.stopPropagation(); },
    };
  }

  /* --------------------------------------------------------- the New Video */

  var PRESETS = [
    { key: "auto", name: "Auto", why: "Script ke mood se khud chunta hai", rec: true },
    { key: "cinematic", name: "Cinematic", why: "Lambe shots, teal-orange" },
    { key: "tense", name: "Tense", why: "Chhote cuts, high contrast" },
    { key: "documentary", name: "Documentary", why: "Slow push, flat grade" },
  ];
  var PACES = [["calm", "Calm"], ["normal", "Normal"],
               ["quick", "Quick"], ["rapid", "Rapid"]];

  var VERDICT = { READY: ["ok", "OK"], GAPS: ["warn", "GAPS"],
                  BLOCKED: ["bad", "BLOCKED"] };

  function newVideoScope() {
    var f = state.form;
    var t = state.task;
    var report = (t && t.report && t.report.verdict) ? t.report : null;
    var running = !!t && t.status === "running";
    var chosen = titleNamed(f.title);
    var tone = chosen ? (TONES[chosen.status] || "muted") : "muted";

    var verdictTone = "busy", verdictLabel = "WORKING", verdictWhy = t ? (t.stage || "") : "";
    if (report) {
      var v = VERDICT[report.verdict] || ["busy", report.verdict];
      verdictTone = v[0];
      verdictLabel = v[1];
      verdictWhy = report.percent + "% shots placeable · "
        + report.beats + " scenes, " + report.shots + " shots";
    }
    if (t && t.status === "failed") { verdictTone = "bad"; verdictLabel = "FAILED"; }
    if (t && t.kind === "build" && t.status === "done") {
      verdictTone = "ok"; verdictLabel = "BUILT"; verdictWhy = t.stage || "";
    }

    return {
      onNewVideo: state.nav === "New Video",

      pickedName: f.title || "koi title nahi",
      pickedDetail: chosen ? chosen.detail : "Library me jaake ek banao",
      pickedDot: dot(tone),
      srcOpen: state.srcOpen,
      toggleSrc: function () { setState({ srcOpen: !state.srcOpen }); },
      srcOptions: allTitles().map(function (row) {
        var on = row.name === f.title;
        return {
          name: row.name, detail: row.detail,
          dotStyle: dot(TONES[row.status] || "muted"),
          rowStyle: "display:flex; align-items:center; gap:10px; padding:9px 11px; border-radius:8px; cursor:pointer;"
            + (on ? " background:var(--accent-soft);" : ""),
          nameStyle: "flex:1; font-size:13px;" + (on ? " font-weight:550; color:var(--accent);" : ""),
          pick: function () { f.title = row.name; remember(); setState({ srcOpen: false }); },
        };
      }),

      scriptName: f.script ? baseName(f.script) : "koi script nahi chuni",
      scriptNameStyle: "font-family:'Cascadia Code', Consolas, monospace; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:"
        + (f.script ? "var(--text)" : "var(--faint)") + ";",
      pickScript: function () { openPicker("script", "script"); },
      scriptOk: !!state.script && !state.scriptError,
      script: state.script || { beats: 0, shots: 0 },
      scriptEpisodes: state.script
        ? (state.script.episodes.length
            ? state.script.episodes.slice(0, 8).join(", ")
              + (state.script.episodes_total > 8
                 ? " +" + (state.script.episodes_total - 8) : "")
            : (state.script.titles || []).join(", ") || "koi episode named nahi")
        : "",
      scriptError: state.scriptError,

      audioName: f.audio ? baseName(f.audio) : "koi voiceover nahi",
      audioNameStyle: "flex:1; min-width:0; font-family:'Cascadia Code', Consolas, monospace; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:"
        + (f.audio ? "var(--text)" : "var(--faint)") + ";",
      audioLength: state.audio && state.audio.seconds
        ? clock(state.audio.seconds) : "",
      pickAudio: function () { openPicker("audio", "audio"); },

      videoTitle: f.name,
      setVideoTitle: function (ev) { f.name = ev.target.value; setQuiet({}); },
      outFolder: f.out,
      setOutFolder: function (ev) { f.out = ev.target.value; setQuiet({}); },
      pickOut: function () { openPicker("folder", "out"); },

      presets: PRESETS.map(function (p) {
        return { name: p.name, why: p.why, recommended: !!p.rec,
                 style: presetCard(f.preset === p.key),
                 pick: function () { f.preset = p.key; remember(); draw(); } };
      }),
      q1080: seg2(f.quality === "1080"),
      q4k: seg2(f.quality === "4k"),
      is4k: f.quality === "4k",
      set1080: function () { f.quality = "1080"; remember(); draw(); },
      set4k: function () { f.quality = "4k"; remember(); draw(); },
      paces: PACES.map(function (p) {
        return { name: p[1], style: seg2(f.pace === p[0]),
                 pick: function () { f.pace = p[0]; remember(); draw(); } };
      }),
      clipSeconds: f.clip,
      setClip: function (ev) { f.clip = ev.target.value; setQuiet({}); },

      checkBtn: SECONDARY + (running ? " opacity:.5; pointer-events:none;" : ""),
      exportBtn: "color:var(--muted); font-size:12.5px; font-weight:550; padding:9px 13px; border-radius:9px; cursor:pointer; white-space:nowrap; transition:all .14s ease;"
        + (running ? " opacity:.5; pointer-events:none;" : ""),
      buildBtn: "display:flex; align-items:center; gap:7px; background:var(--accent); color:var(--on-accent); font-size:13px; font-weight:600; padding:10px 16px; border-radius:9px; cursor:pointer; white-space:nowrap; box-shadow:var(--shadow-sm); transition:background .15s ease;"
        + (running ? " opacity:.5; pointer-events:none;" : ""),
      runCheck: function () { run("/api/check"); },
      buildEditor: function () { run("/api/build", { after: "editor" }); },
      buildExport: function () { run("/api/build", { after: "export" }); },

      noPanel: !t || state.panelDismissed,
      panelOpen: !!t && !state.panelDismissed,
      closePanel: function () { setState({ panelDismissed: true }); },
      verdictStyle: badgeStyle(verdictTone),
      verdictLabel: verdictLabel,
      verdictWhy: verdictWhy,
      taskRunning: running,
      // Pre-flight knows how much work there is only once it has read the
      // script, so for the first half-minute there is no percentage to show.
      // A bar frozen at zero is how a tool that is working looks broken, so
      // that stretch gets a moving one instead of a still one.
      barStyle: (running && !(t && t.scenes_total))
        ? "height:100%; border-radius:99px; background:linear-gradient(90deg,var(--border) 0%,var(--busy) 50%,var(--border) 100%); background-size:220px 100%; animation:shimmer 1.1s linear infinite;"
        : "width:" + (t ? t.percent : 0) + "%; height:100%; background:var(--busy); border-radius:99px; transition:width .3s ease;",
      taskStage: t ? (t.stage || "chal raha hai…") : "",
      taskElapsed: t ? clock(t.seconds) : "",
      taskFailed: !!t && (t.status === "failed" || t.status === "blocked"),
      taskError: t ? (t.error || t.stage || "") : "",
      hasReport: !!report,
      reportChecks: (report ? report.checks : []).map(function (c) {
        var tint = c.ok ? "ok" : (c.fatal ? "bad" : "warn");
        return { name: c.name, detail: c.detail,
                 icon: c.ok ? "✓" : (c.fatal ? "✗" : "!"),
                 mark: "flex:0 0 16px; text-align:center; font-size:12px; font-weight:700; color:var(--" + tint + ");" };
      }),
      hasWeak: !!report && (report.weak_scenes || []).length > 0,
      weakScenes: report ? report.weak_scenes : [],
      builtOk: !!t && t.kind === "build" && t.status === "done",
      hasLines: !!t && (t.lines || []).length > 0,
      taskLines: t ? (t.lines || []) : [],
    };
  }

  /* ----------------------------------------------------------------- scope */

  var STUB = {
    "Queue": "Yahan saari videos ki list hogi — jo ban rahi hai aur jo ban chuki.",
    "Editor": "Yahan timeline khulegi — shot badalna, duration, export.",
    "Settings": "Folders, default quality, ffmpeg ka path.",
  };

  function scope() {
    var lib = state.library || { titles: [], counts: {}, databases: [], root: "" };
    var go = function (name) {
      return function () { setState({ nav: name }); };
    };
    var rows = visible(lib.titles || []);
    var first = (lib.databases || [])[0] || "";
    var home = lib.root || first.replace(/[\\/][^\\/]*$/, "");
    var count = (lib.titles || []).length;

    var common = {
      theme: state.theme,
      collapsed: state.collapsed,
      expanded: !state.collapsed,
      logoTitle: state.collapsed ? "Sidebar kholo" : "Sidebar chhota karo",
      toggleSidebar: function () {
        localStorage.setItem("me.collapsed", state.collapsed ? "0" : "1");
        setState({ collapsed: !state.collapsed });
      },
      toggleTheme: function () { setTheme(state.theme === "dark" ? "light" : "dark"); },
      setLight: function () { setTheme("light"); },
      setDark: function () { setTheme("dark"); },
      lightBtn: segStyle("light"),
      darkBtn: segStyle("dark"),
      footer: (home || "—") + " · " + count + (count === 1 ? " title" : " titles"),

      sidebarStyle: "width:" + (state.collapsed ? 64 : 228) + "px; flex:0 0 "
        + (state.collapsed ? 64 : 228)
        + "px; background:var(--sidebar); border-right:1px solid var(--border); display:flex; flex-direction:column; transition:width .18s ease, flex-basis .18s ease; overflow:hidden;",
      sideGroupStyle: "padding:" + (state.collapsed ? "6px 10px 0 10px" : "6px 12px 0 12px")
        + "; display:flex; flex-direction:column; gap:2px;",
      sideGroup2Style: "padding:" + (state.collapsed ? "12px 10px 0 10px" : "14px 12px 0 12px")
        + "; display:flex; flex-direction:column; gap:2px;",
      groupLabel: "padding:8px 8px 6px 8px; font-size:10px; font-weight:650; letter-spacing:0.1em; color:var(--faint); white-space:nowrap; "
        + (state.collapsed ? "display:none;" : ""),
      soonItem: "display:flex; align-items:center; gap:10px; border-radius:8px; font-size:13px; color:var(--faint); opacity:.6; cursor:not-allowed; white-space:nowrap; overflow:hidden; "
        + (state.collapsed ? "padding:9px 0; justify-content:center;" : "padding:7px 10px;"),
      labelStyle: state.collapsed ? "display:none;" : "",

      navNewVideo: navStyle("New Video"), navQueue: navStyle("Queue"),
      navEditor: navStyle("Editor"), navLibrary: navStyle("Library"),
      navSettings: navStyle("Settings"),
      goNewVideo: go("New Video"), goQueue: go("Queue"), goEditor: go("Editor"),
      goLibrary: go("Library"), goSettings: go("Settings"),

      onLibrary: state.nav === "Library",
      onStub: state.nav !== "Library" && state.nav !== "New Video",
      stubTitle: state.nav,
      stubWhy: STUB[state.nav] || "Abhi ban raha hai.",
      stubGoLabel: state.nav === "Editor" ? "Purana shot page kholo"
                                          : "Library kholo",
      stubGo: state.nav === "Editor"
        ? function () { window.location.href = "/shots"; }
        : go("Library"),

      loading: state.loading,
      failed: state.failed,
      ready: !state.loading && !state.failed,
      nothing: !state.loading && !state.failed && rows.length === 0,
      emptyWhy: count
        ? "Is filter me koi title nahi. Upar 'All' dabao."
        : "Koi library nahi mili. start.bat kholo, 8 se media folder set karo, phir 4 aur L chalao.",
      refresh: function () { loadLibrary(); },

      counts: {
        all: (lib.counts || {}).all || 0,
        series: (lib.counts || {}).series || 0,
        movies: (lib.counts || {}).movies || 0,
        attention: (lib.counts || {}).attention || 0,
      },
      chipAll: chipStyle("all"), chipSeries: chipStyle("series"),
      chipMovie: chipStyle("movie"), chipIssue: chipStyle("issue"),
      filterAll: function () { setState({ filter: "all" }); },
      filterSeries: function () { setState({ filter: "series" }); },
      filterMovie: function () { setState({ filter: "movie" }); },
      filterIssue: function () { setState({ filter: "issue" }); },

      shown: rows.map(titleView),
      databases: lib.databases || [],
      chooseBtn: SECONDARY,
    };

    return Object.assign(common, newVideoScope(), pickerScope());
  }

  function applyTheme(name) {
    // The page background, so the strip outside the app matches. Set on the
    // document rather than in the design's stylesheet, which only knows
    // about the element carrying data-theme.
    document.documentElement.style.background =
      name === "dark" ? "#0b0e13" : "#f6f7f9";
    setState({ theme: name });
  }

  function setTheme(name) {
    // Only a click writes the preference. Applying the current one at
    // start-up must not, or the tool records a choice nobody made.
    localStorage.setItem("me.theme", name);
    applyTheme(name);
  }

  /* ----------------------------------------------------------------- start */

  function draw() {
    if (!where || !screens) return;
    window.DCX.render(where, screens, scope());
  }

  function start() {
    where = document.getElementById("app");
    fetch("/ui/design").then(function (r) { return r.text(); })
      .then(function (text) {
        var style = document.createElement("style");
        style.textContent = window.DCX.unwrap(text).styles;
        document.head.appendChild(style);
      }).catch(function () {
        // The design file is how the page gets its colours. Without it every
        // var(--x) is empty and the screen is unreadable — better to say so
        // than to show white text on white.
        document.body.innerHTML =
          '<pre style="font:13px monospace; padding:30px; color:#b00">'
          + "shared/design/Movie Editor.dc.html nahi mili.\n"
          + "Design ke bina page ke colours hi nahi hai." + "</pre>";
        throw new Error("no design");
      })
      .then(function () {
        return fetch("/ui/screens").then(function (r) { return r.text(); });
      })
      .then(function (text) {
        screens = text;
        applyTheme(state.theme);
        if (state.form.script) readScript(state.form.script);
        if (state.form.audio) readAudio(state.form.audio);
        return loadLibrary();
      })
      .catch(function () { /* already reported on the page */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
