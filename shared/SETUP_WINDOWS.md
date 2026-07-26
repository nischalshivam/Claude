# Setting this up on Windows

The error `No module named media_index` means exactly one thing: the code is
on GitHub, not on this PC yet. Nothing is broken. These four steps fix it.

---

## Step 1 — get the code onto the PC

Open this link and the download starts:

```
https://github.com/nischalshivam/Claude/archive/refs/heads/claude/video-clip-relevance-issue-khs33k.zip
```

Then:

1. Right-click the downloaded `.zip` → **Extract All…**
2. Extract it somewhere easy, e.g. `D:\VideoTool`
3. Inside you will find a folder ending in `…-khs33k`, and inside **that** a
   folder called **`shared`**

**`shared` is the folder you work in.** Everything below happens there.

> Prefer git? `git clone -b claude/video-clip-relevance-issue-khs33k https://github.com/nischalshivam/Claude.git`
> — then updates are one `git pull` instead of a fresh download.

---

## Step 2 — run `setup.bat`

Open the `shared` folder and **double-click `setup.bat`**.

It checks for Python, installs an optional speed-up, checks for ffmpeg, and
runs the test suite. It tells you what is missing and how to get it.

### If it says Python was not found

Install from <https://www.python.org/downloads/>.
**Tick "Add python.exe to PATH"** on the first install screen — that box is
the whole difference between it working and not.

### If it says ffmpeg was not found

ffmpeg is required — it is what reads inside video files and cuts clips.
`setup.bat` will offer to install it with winget. If you prefer to do it
yourself, open PowerShell and run:

```
winget install Gyan.FFmpeg
```

Then **close the window, open a new one**, and run `setup.bat` again. A new
window is needed because PATH changes only apply to newly opened windows.

You should end with:

```
[OK] Python 3.x
[OK] rapidfuzz installed
[OK] ffmpeg 7.x
[OK] all tests passed
```

---

## Step 3 — check your download

**Drag the `Breaking Bad Season 2` folder onto `check.bat`.**

Or open Command Prompt in the `shared` folder and run:

```
check.bat "D:\Breaking Bad Season 2"
```

You get a verdict per episode:

```
MEDIA CHECK — 13 file(s)

  ✅ Breaking Bad S02E01   47m  1920x1080  subs: embedded    684
  ⚠️  Breaking Bad S02E04   47m  1920x1080  subs: none
        no subtitles at all
        → download an English .srt named 'Breaking Bad Season 2 Episode 4.en.srt'

  12 ready · 1 need subtitles · 0 unreadable
```

For any `⚠️`, download the subtitle from <https://www.opensubtitles.org>, save
it **next to the video with exactly the filename shown**, and run `check.bat`
again.

---

## Step 4 — build the index

Once everything is `✅`:

```
mi.bat build "D:\Breaking Bad Season 2" --db library.db --verify-sync
```

Then test any line you remember:

```
mi.bat find "I am the one who knocks" --db library.db
```

If that returns the right episode and timestamp, the whole system is proven on
real footage.

---

## The three files in `shared`

| File | What it does |
|---|---|
| `setup.bat` | one-time setup and health check |
| `check.bat` | inspect a downloaded folder (drag a folder onto it) |
| `mi.bat` | run any command — `mi.bat build …`, `mi.bat find …`, `mi.bat run jobs.json` |

`mi.bat` with no arguments prints the list of commands.

---

## Two things worth knowing

**Open Command Prompt in the right folder.** In Explorer, open the `shared`
folder, click the address bar, type `cmd`, press Enter. The prompt opens
already in that folder. `mi.bat` and `check.bat` also work by double-click.

**Paths with spaces need quotes.** `"D:\Breaking Bad Season 2"` — with the
quotes. Without them Windows reads it as three separate arguments. Dragging a
folder onto `check.bat` adds the quotes for you.
