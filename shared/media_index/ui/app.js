/* The Movie Editor, wired to the tool.
 *
 * The design decides how this looks; this decides what is true. Every number
 * on the Library screen is read from the database that the menu already
 * writes — nothing here keeps its own copy of anything, so the browser and
 * the terminal can be open at once and neither can be wrong about the other.
 *
 * The style helpers below (nav, chip, seg) are ported from the design's own
 * script, unchanged in what they produce. They live here rather than being
 * evaluated out of the design file because a design is a drawing: it should
 * never be able to decide what the tool does.
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
  };

  var screens = "";
  var where = null;

  function setState(patch) {
    Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    draw();
  }

  /* ------------------------------------------------------------- fetching */

  function get(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error || ("HTTP " + r.status));
        return body;
      });
    });
  }

  function loadLibrary() {
    setState({ loading: true, failed: "" });
    return get("/api/titles").then(function (data) {
      setState({ library: data, loading: false });
    }).catch(function (err) {
      setState({ loading: false, failed: String(err.message || err) });
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

  // The four status colours the design defines. A title's tone is decided
  // once, here, so the badge, its dot and the tile all agree.
  var TONES = { ready: "ok", partial: "busy", attention: "warn", empty: "muted" };

  function badgeStyle(tone) {
    var base = "display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:550; padding:4px 10px; border-radius:999px; white-space:nowrap; ";
    if (tone === "muted") {
      return base + "color:var(--muted); background:var(--raised); border:1px solid var(--border);";
    }
    return base + "color:var(--" + tone + "); background:var(--" + tone
      + "-soft); border:1px solid var(--" + tone + "-line);";
  }

  function initialsOf(name) {
    var words = String(name || "?").split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  /* ------------------------------------------------------------ view model */

  function titleView(t) {
    var tone = TONES[t.status] || "muted";
    var counted = t.kind === "movie"
      ? (t.size === "—" ? "not indexed" : t.size)
      : (t.files + " episode" + (t.files === 1 ? "" : "s")
         + (t.size === "—" ? "" : " · " + t.size));
    return {
      name: t.name,
      kind: t.kind,
      media_root: t.media_root || "—",
      counted: counted,
      detail: t.detail,
      files: t.files,
      indexed: t.indexed,
      missing: t.missing,
      percent: t.files ? Math.round(t.indexed * 100 / t.files) : 0,
      partial: t.status === "partial" || (t.indexed > 0 && t.indexed < t.files),
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

  /* ----------------------------------------------------------------- scope */

  function scope() {
    var lib = state.library || { titles: [], counts: {}, databases: [], root: "" };
    var go = function (name) {
      return function () { setState({ nav: name }); };
    };
    var rows = visible(lib.titles || []);
    // Where the libraries actually are, which is the Libraries folder once
    // one is set and until then the folder the database sits in. Naming the
    // real place beats "no Libraries folder set", which reads like a fault
    // when nothing is wrong.
    var first = (lib.databases || [])[0] || "";
    var home = lib.root || first.replace(/[\\/][^\\/]*$/, "");
    var count = (lib.titles || []).length;
    var footer = (home || "—") + " · " + count + (count === 1 ? " title" : " titles");

    return {
      theme: state.theme,
      collapsed: state.collapsed,
      expanded: !state.collapsed,
      toggleSidebar: function () {
        localStorage.setItem("me.collapsed", state.collapsed ? "0" : "1");
        setState({ collapsed: !state.collapsed });
      },
      logoTitle: state.collapsed ? "Sidebar kholo" : "Sidebar chhota karo",
      toggleTheme: function () { setTheme(state.theme === "dark" ? "light" : "dark"); },
      setLight: function () { setTheme("light"); },
      setDark: function () { setTheme("dark"); },
      lightBtn: segStyle("light"),
      darkBtn: segStyle("dark"),
      footer: footer,

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
      onStub: state.nav !== "Library",
      stubTitle: state.nav,
      stubWhy: STUB[state.nav] || "Abhi ban raha hai.",
      // Editor is the one stub with somewhere real to send people: the
      // shot-by-shot page has worked since the sixth build and still does.
      stubGoLabel: state.nav === "Editor" ? "Purana shot page kholo"
                                          : "Library kholo",
      stubGo: state.nav === "Editor"
        ? function () { window.location.href = "/shots"; }
        : go("Library"),

      loading: state.loading,
      failed: state.failed,
      ready: !state.loading && !state.failed,
      nothing: !state.loading && !state.failed && rows.length === 0,
      emptyWhy: (lib.titles || []).length
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
    };
  }

  var STUB = {
    "New Video": "Yahan script aur voiceover dekar video banegi. Abhi start.bat ka 9 aur T karta hai.",
    "Queue": "Yahan saari videos ki list hogi — jo ban rahi hai aur jo ban chuki.",
    "Editor": "Yahan timeline khulegi — shot badalna, duration, export.",
    "Settings": "Folders, default quality, ffmpeg ka path.",
  };

  function setTheme(name) {
    localStorage.setItem("me.theme", name);
    document.documentElement.style.background =
      name === "dark" ? "#0b0e13" : "#f6f7f9";
    setState({ theme: name });
  }

  /* ----------------------------------------------------------------- start */

  function draw() {
    if (!where || !screens) return;
    window.DCX.render(where, screens, scope());
  }

  function start() {
    where = document.getElementById("app");
    var design = fetch("/ui/design").then(function (r) { return r.text(); })
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
          + "media_index/design/Movie Editor.dc.html nahi mili.\n"
          + "Design ke bina page ke colours hi nahi hai." + "</pre>";
        throw new Error("no design");
      });
    design.then(function () {
      return fetch("/ui/screens").then(function (r) { return r.text(); });
    }).then(function (text) {
      screens = text;
      setTheme(state.theme);
      return loadLibrary();
    }).catch(function () { /* already reported on the page */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
